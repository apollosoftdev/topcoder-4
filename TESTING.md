# Marathon Match Processor - Testing Guide

This document provides comprehensive testing instructions for the Marathon Match Processor fan-out architecture.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Testing](#local-testing)
3. [AWS Deployment Testing](#aws-deployment-testing)
4. [End-to-End Test Scenarios](#end-to-end-test-scenarios)
5. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Local Development
- Node.js >= 20.0.0
- npm >= 9.0.0
- Docker (for CDK bundling and Semgrep)

### AWS Deployment
- AWS CLI configured with appropriate credentials
- AWS CDK CLI installed (`npm install -g aws-cdk`)
- Permissions for: Lambda, ECS, SNS, SQS, DynamoDB, EventBridge, MSK, VPC, IAM

---

## Local Testing

### 1. Unit Tests

Run all unit tests for Lambda functions:

```bash
# Run all tests (CDK + Lambdas)
npm run test:all

# Run only Lambda tests
npm run test:lambdas

# Run individual Lambda tests
npm run test:router      # Router Lambda
npm run test:watcher     # Submission Watcher Lambda
npm run test:completion  # Completion Lambda

# Run CDK tests
npm run test
```

### 2. Integration Test (Local Simulation)

The integration test simulates the complete flow without AWS:

```bash
# Normal mode - all tasks succeed
npm run test:integration

# Failure simulation - tests retry mechanism
npm run test:integration:failure

# Verbose mode - detailed logging
npm run test:integration:verbose
```

### 3. Linting

```bash
# Run ESLint
npm run lint
npm run lint:fix

```

### 4. CDK Synthesis

Verify CloudFormation template generation:

```bash
# Synthesize without Docker bundling (faster)
SIMPLE_BUNDLING=true npm run synth

# Full synthesis with Docker bundling
npm run synth
```

---

## AWS Deployment Testing

### Step 1: Deploy the Stack

```bash
# Configure environment variables (copy from .env.example)
cp .env.example .env
# Edit .env with your AWS configuration

# Deploy
npm run deploy
```

### Step 2: Seed DynamoDB

After deployment, seed the challenge-queue mapping table. The deployment outputs a CLI command:

```bash
# Get the seed command from deployment outputs
aws cloudformation describe-stacks --stack-name MatchScorerStack \
  --query "Stacks[0].Outputs[?OutputKey=='DynamoDBSeedCommand'].OutputValue" \
  --output text | bash
```

Or manually:

```bash
aws dynamodb put-item \
  --table-name challenge-queue-mapping \
  --item '{
    "challengeId": {"S": "00000000-0000-0000-0000-000000000000"},
    "queueUrl": {"S": "<QUEUE_URL_FROM_OUTPUT>"},
    "queueArn": {"S": "<QUEUE_ARN_FROM_OUTPUT>"},
    "challengeName": {"S": "BioSlime"},
    "active": {"BOOL": true}
  }'
```

### Step 3: Set Up SSM Parameters

Create challenge configuration in SSM Parameter Store:

```bash
# Challenge config
aws ssm put-parameter \
  --name "/scorer/challenges/00000000-0000-0000-0000-000000000000/config" \
  --type String \
  --value '{"name":"BioSlime","active":true,"scorers":["example","provisional"]}'

# Scorer configs
aws ssm put-parameter \
  --name "/scorer/challenges/00000000-0000-0000-0000-000000000000/scorers/example/config" \
  --type String \
  --value '{"name":"example","testerClass":"com.topcoder.challenges.mm160.BioSlimeTester","timeLimit":30000}'

aws ssm put-parameter \
  --name "/scorer/challenges/00000000-0000-0000-0000-000000000000/scorers/provisional/config" \
  --type String \
  --value '{"name":"provisional","testerClass":"com.topcoder.challenges.mm160.BioSlimeTester","timeLimit":60000}'
```

### Step 4: Send Test Message via Kafka

Use the test-data-sender Lambda to send a test message to Kafka:

```bash
# Invoke test-data-sender Lambda
aws lambda invoke \
  --function-name TestDataSenderLambda \
  --payload '{"payload":{"submissionId":"11111111-1111-1111-1111-111111111111","challengeId":"00000000-0000-0000-0000-000000000000"}}' \
  --cli-binary-format raw-in-base64-out \
  response.json

cat response.json
```

### Step 5: Monitor CloudWatch Logs

Watch the logs for each Lambda in the processing chain:

```bash
# Router Lambda logs
aws logs tail /aws/lambda/RouterLambda --follow

# Submission Watcher Lambda logs
aws logs tail /aws/lambda/SubmissionWatcher-BioSlime --follow

# Completion Lambda logs
aws logs tail /aws/lambda/CompletionLambda --follow
```

### Step 6: Verify Processing

Check each component:

```bash
# Check SNS messages published
aws sns list-topics

# Check SQS queue messages
aws sqs get-queue-attributes \
  --queue-url <QUEUE_URL> \
  --attribute-names ApproximateNumberOfMessages

# Check ECS tasks
aws ecs list-tasks --cluster <CLUSTER_NAME>

# Check EventBridge rules
aws events list-rules --name-prefix ecs-task-state
```

---

## End-to-End Test Scenarios

### Scenario 1: Successful Submission Processing

**Expected Flow:**
1. Kafka message received by Router Lambda
2. Router validates and publishes to SNS
3. SNS delivers to SQS queue
4. Submission Watcher receives SQS message
5. ECS tasks launched for each scorer
6. Tasks complete successfully
7. EventBridge triggers Completion Lambda
8. Completion Lambda logs SUCCESS

**Verification:**
```bash
# Check Completion Lambda logs for TASK_SUCCESS
aws logs filter-log-events \
  --log-group-name /aws/lambda/CompletionLambda \
  --filter-pattern "TASK_SUCCESS"
```

### Scenario 2: Invalid Submission (Bad UUID)

**Test Input:**
```json
{"payload":{"submissionId":"invalid-uuid","challengeId":"00000000-0000-0000-0000-000000000000"}}
```

**Expected:**
- Router Lambda skips message
- No SNS publish
- Log: "Invalid submissionId format"

### Scenario 3: Inactive Challenge

**Setup:**
```bash
aws dynamodb update-item \
  --table-name challenge-queue-mapping \
  --key '{"challengeId":{"S":"00000000-0000-0000-0000-000000000000"}}' \
  --update-expression "SET active = :a" \
  --expression-attribute-values '{":a":{"BOOL":false}}'
```

**Expected:**
- Router Lambda skips message
- Log: "Skipping message for inactive/unknown challenge"

### Scenario 4: ECS Task Failure with Retry

**To simulate task failure:**
1. Configure scorer to fail (e.g., invalid tester class)
2. Send submission
3. Task fails, Completion Lambda queues retry
4. After MAX_RETRIES, message goes to DLQ

**Verification:**
```bash
# Check for retry messages
aws logs filter-log-events \
  --log-group-name /aws/lambda/CompletionLambda \
  --filter-pattern "Queueing retry"

# Check DLQ
aws sqs get-queue-attributes \
  --queue-url <DLQ_URL> \
  --attribute-names ApproximateNumberOfMessages
```

### Scenario 5: Max Retries Exceeded

**Test:**
1. Ensure task fails consistently
2. Observe retries up to MAX_RETRIES (default: 3)
3. After max retries, message moves to DLQ

**Expected Logs:**
```
Max retries (3) reached for submission xxx. Not retrying.
```

---

## Troubleshooting

### Router Lambda Not Receiving Kafka Messages

1. Check MSK cluster connectivity
2. Verify Lambda security group can access MSK
3. Check Event Source Mapping:
   ```bash
   aws lambda list-event-source-mappings --function-name RouterLambda
   ```

### SNS Not Delivering to SQS

1. Check SNS subscription:
   ```bash
   aws sns list-subscriptions-by-topic --topic-arn <TOPIC_ARN>
   ```
2. Verify filter policy matches challengeId

### ECS Tasks Not Starting

1. Check ECS cluster capacity
2. Verify task definition exists
3. Check IAM permissions for Lambda to run tasks
4. Check VPC/subnet configuration

### Completion Lambda Not Triggered

1. Verify EventBridge rule:
   ```bash
   aws events describe-rule --name <RULE_NAME>
   ```
2. Check rule target:
   ```bash
   aws events list-targets-by-rule --rule <RULE_NAME>
   ```

### Retry Not Working

1. Verify DynamoDB has queue URL for challenge
2. Check Completion Lambda has SQS permissions
3. Verify MAX_RETRIES environment variable

---

## Quick Reference

| Component | CloudWatch Log Group |
|-----------|---------------------|
| Router Lambda | `/aws/lambda/RouterLambda` |
| Submission Watcher | `/aws/lambda/SubmissionWatcher-{ChallengeName}` |
| Completion Lambda | `/aws/lambda/CompletionLambda` |
| ECS Tasks | `/ecs/match-scorer` |

| Useful Commands | Description |
|-----------------|-------------|
| `npm run test:all` | Run all tests |
| `npm run test:integration` | Local integration test |
| `npm run synth` | Generate CloudFormation |
| `npm run deploy` | Deploy to AWS |
| `npm run destroy` | Destroy AWS resources |

---

## Architecture Verification Checklist

- [ ] Kafka (MSK) topic exists and is accessible
- [ ] Router Lambda has MSK event source mapping
- [ ] SNS topic created with correct subscriptions
- [ ] SQS queues created with DLQs
- [ ] DynamoDB table populated with challenge mappings
- [ ] Submission Watcher Lambdas deployed (one per challenge)
- [ ] ECS cluster and task definition ready
- [ ] EventBridge rule targets Completion Lambda
- [ ] All IAM permissions in place
- [ ] SSM parameters configured for challenges
