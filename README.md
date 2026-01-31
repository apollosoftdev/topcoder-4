# Topcoder Marathon Match Processor

A serverless, event-driven architecture for processing Topcoder Marathon Match submissions using AWS Lambda, SNS, SQS, ECS Fargate, and EventBridge.

## Architecture

```
MSK → Router Lambda → SNS Topic → SQS Queues (per challenge) → Challenge Lambdas → ECS Tasks
                                                                      ↓
                                          EventBridge ← ECS Task State Change Events
                                               ↓
                                          Completion Lambda → Update Submission Status
```

### Components

1. **Router Lambda** - Receives Kafka messages from MSK, validates submissions, and routes them to SNS with challenge-specific message attributes.

2. **SNS/SQS Fan-out** - SNS topic with per-challenge SQS queues using subscription filter policies based on `challengeId`.

3. **Challenge Lambda** - Per-challenge Lambda functions that load configuration from SSM Parameter Store at cold start (cached for warm invocations) and launch ECS Fargate tasks asynchronously.

4. **ECS Fargate Tasks** - Container-based scorer tasks that process submissions. Task definitions are configured per challenge.

5. **Completion Lambda** - Handles ECS task completion events via EventBridge and updates submission status through the Topcoder Submission API.

## Project Structure

```
topcoder-4/
├── router_lambda/          # MSK message router
│   ├── handler.py
│   ├── validator.py
│   └── requirements.txt
├── challenge_lambda/       # Per-challenge ECS task launcher
│   ├── handler.py
│   ├── config_loader.py
│   ├── ecs_runner.py
│   └── requirements.txt
├── completion_lambda/      # ECS completion event handler
│   ├── handler.py
│   ├── submission_api.py
│   └── requirements.txt
├── infrastructure/         # CDK infrastructure code
│   ├── app.py
│   ├── mm_processor_stack.py
│   ├── mm_constructs/
│   │   ├── router_lambda.py
│   │   ├── fanout.py
│   │   ├── challenge_processor.py
│   │   └── completion_handler.py
│   ├── cdk.json
│   └── requirements.txt
├── tests/                  # Unit tests
│   ├── test_router.py
│   ├── test_challenge.py
│   ├── test_completion.py
│   └── conftest.py
├── README.md
└── VALIDATION.md
```

## Prerequisites

- AWS CLI configured with appropriate credentials
- Python 3.12
- AWS CDK v2
- Existing infrastructure:
  - VPC with private subnets
  - MSK cluster
  - ECS cluster
  - ECS task definitions for scorer containers

## Configuration

### SSM Parameter Store Structure

```
/mm-processor/
├── challenges/
│   ├── {challenge-id-1}/
│   │   └── config          # JSON configuration
│   └── {challenge-id-2}/
│       └── config
└── auth0/
    └── token               # Auth0 bearer token (encrypted)
```

### Challenge Configuration Example

```json
{
  "challengeId": "challenge-123",
  "scorerType": "marathon",
  "ecsCluster": "mm-scorer-cluster",
  "ecsTaskDefinition": "mm-scorer-task:1",
  "timeout": 3600,
  "memoryLimit": 4096
}
```

## Deployment

### 1. Install CDK dependencies

```bash
cd infrastructure
pip install -r requirements.txt
```

### 2. Configure environment

Set required context values or environment variables:

```bash
export VPC_ID="vpc-xxxxxxxxx"
export MSK_CLUSTER_ARN="arn:aws:kafka:region:account:cluster/name/id"
export KAFKA_BOOTSTRAP_SERVERS="b-1.msk-cluster:9092,b-2.msk-cluster:9092"
export KAFKA_TOPIC="submissions"
export ECS_CLUSTER_ARN="arn:aws:ecs:region:account:cluster/name"
export SUBMISSION_API_URL="https://api.topcoder.com/v5"
export ECS_SUBNETS="subnet-1,subnet-2"
export ECS_SECURITY_GROUP="sg-xxxxxxxxx"
export CHALLENGE_IDS="challenge-1,challenge-2,challenge-3"
```

### 3. Deploy stack

```bash
cd infrastructure
cdk deploy
```

Or with context values:

```bash
cdk deploy \
  --context vpc_id=vpc-xxxxxxxxx \
  --context msk_cluster_arn=arn:aws:kafka:... \
  --context challenge_ids=challenge-1,challenge-2
```

## Testing

### Run unit tests

```bash
cd tests
pip install -r requirements.txt
pytest -v
```

### Run with coverage

```bash
pytest --cov=../router_lambda --cov=../challenge_lambda --cov=../completion_lambda -v
```

## Message Formats

### Submission Message (from Kafka)

```json
{
  "id": "submission-123",
  "challengeId": "challenge-456",
  "url": "https://submissions.topcoder.com/submission.zip",
  "memberId": "member-789",
  "created": "2024-01-15T10:00:00Z"
}
```

### ECS Task State Change Event (from EventBridge)

```json
{
  "detail-type": "ECS Task State Change",
  "source": "aws.ecs",
  "detail": {
    "taskArn": "arn:aws:ecs:region:account:task/cluster/task-id",
    "lastStatus": "STOPPED",
    "stoppedReason": "Essential container exited",
    "containers": [{
      "name": "scorer",
      "exitCode": 0
    }],
    "overrides": {
      "containerOverrides": [{
        "name": "scorer",
        "environment": [
          {"name": "SUBMISSION_ID", "value": "submission-123"}
        ]
      }]
    }
  }
}
```

## Monitoring

- **CloudWatch Logs**: Each Lambda function logs to its own log group
- **CloudWatch Metrics**: Monitor Lambda invocations, errors, and durations
- **SQS DLQ**: Failed messages are sent to per-challenge dead-letter queues
- **ECS Task Events**: EventBridge captures all task state changes

## Error Handling

1. **Invalid Messages**: Logged and skipped by Router Lambda
2. **Processing Failures**: Messages retry 3 times before moving to DLQ
3. **ECS Task Failures**: Captured via EventBridge, submission marked as FAILED
4. **API Failures**: Lambda raises exception, allowing retry

## Scaling

- **Router Lambda**: Automatically scales with MSK partition count
- **Challenge Lambdas**: Scale independently per challenge based on SQS depth
- **ECS Tasks**: Limited by account service quotas and cluster capacity

## Security

- All Lambdas run in VPC private subnets
- IAM roles follow least-privilege principle
- Auth tokens stored encrypted in SSM Parameter Store
- ECS tasks run with `assignPublicIp: DISABLED`
