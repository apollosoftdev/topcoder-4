# Validation Guide

This document describes the verification steps to validate the Marathon Match processor deployment.

## Pre-Deployment Validation

### 1. Validate CDK Stack

```bash
cd infrastructure
cdk synth
```

This generates the CloudFormation template and validates the CDK code.

### 2. Run Unit Tests

```bash
cd tests
pip install -r requirements.txt
pytest -v --tb=short
```

Expected output: All tests pass.

## Post-Deployment Validation

### 1. Verify Router Lambda

#### Test with AWS CLI

```bash
# Get Lambda function info
aws lambda get-function --function-name mm-router-lambda

# Check MSK event source mapping
aws lambda list-event-source-mappings --function-name mm-router-lambda
```

#### Send Test Message to MSK

```bash
# Using kafka-console-producer
echo '{"id":"test-123","challengeId":"challenge-1","url":"https://example.com/test.zip","memberId":"member-456"}' | \
  kafka-console-producer --broker-list $KAFKA_BOOTSTRAP_SERVERS --topic submissions
```

#### Verify in CloudWatch Logs

```bash
aws logs tail /aws/lambda/mm-router-lambda --follow
```

Expected log output:
```
Routed submission test-123 to challenge challenge-1
```

### 2. Verify SNS/SQS Fan-out

#### Check SNS Topic Subscriptions

```bash
aws sns list-subscriptions-by-topic --topic-arn arn:aws:sns:$REGION:$ACCOUNT:mm-submission-topic
```

#### Verify Message in SQS Queue

```bash
aws sqs receive-message \
  --queue-url https://sqs.$REGION.amazonaws.com/$ACCOUNT/mm-challenge-1-queue \
  --max-number-of-messages 1
```

Expected: Message with submission payload and SNS wrapper.

### 3. Verify Challenge Lambda

#### Check Lambda Configuration

```bash
aws lambda get-function --function-name mm-challenge-challenge-1-lambda
```

#### Verify SSM Parameter

```bash
aws ssm get-parameter \
  --name /mm-processor/challenges/challenge-1/config \
  --with-decryption
```

#### Send Test Message to SQS

```bash
aws sqs send-message \
  --queue-url https://sqs.$REGION.amazonaws.com/$ACCOUNT/mm-challenge-1-queue \
  --message-body '{"Message":"{\"id\":\"test-456\",\"challengeId\":\"challenge-1\",\"url\":\"https://example.com/test.zip\",\"memberId\":\"member-789\"}"}'
```

#### Verify ECS Task Launch

```bash
aws logs tail /aws/lambda/mm-challenge-challenge-1-lambda --follow
```

Expected log output:
```
Loaded config for challenge challenge-1
Launched ECS task arn:aws:ecs:... for submission test-456
```

#### Check ECS Task Status

```bash
aws ecs list-tasks --cluster $ECS_CLUSTER --family mm-scorer
aws ecs describe-tasks --cluster $ECS_CLUSTER --tasks $TASK_ARN
```

### 4. Verify Completion Lambda

#### Check EventBridge Rule

```bash
aws events describe-rule --name mm-ecs-task-completion
aws events list-targets-by-rule --rule mm-ecs-task-completion
```

#### Wait for ECS Task Completion

Monitor the ECS task until it stops:

```bash
aws ecs wait tasks-stopped --cluster $ECS_CLUSTER --tasks $TASK_ARN
```

#### Verify CloudWatch Logs

```bash
aws logs tail /aws/lambda/mm-completion-lambda --follow
```

Expected log output:
```
Updated submission test-456 to SCORED
```

### 5. Test Dead Letter Queue

#### Simulate Failure

Create an invalid SSM parameter or invalid ECS task definition to cause failures.

#### Verify DLQ

After 3 retries, check the DLQ:

```bash
aws sqs get-queue-attributes \
  --queue-url https://sqs.$REGION.amazonaws.com/$ACCOUNT/mm-challenge-1-dlq \
  --attribute-names ApproximateNumberOfMessages
```

## End-to-End Test

### Full Flow Test

1. **Publish to Kafka**:
   ```bash
   echo '{"id":"e2e-test","challengeId":"challenge-1","url":"https://example.com/submission.zip","memberId":"12345"}' | \
     kafka-console-producer --broker-list $KAFKA_BOOTSTRAP_SERVERS --topic submissions
   ```

2. **Monitor Router Lambda**:
   ```bash
   aws logs tail /aws/lambda/mm-router-lambda --since 1m
   ```

3. **Monitor Challenge Lambda**:
   ```bash
   aws logs tail /aws/lambda/mm-challenge-challenge-1-lambda --since 1m
   ```

4. **Monitor ECS Task**:
   ```bash
   aws ecs list-tasks --cluster $ECS_CLUSTER --family mm-scorer --desired-status RUNNING
   ```

5. **Monitor Completion Lambda**:
   ```bash
   aws logs tail /aws/lambda/mm-completion-lambda --since 5m
   ```

6. **Verify Submission Status** (via API or database).

## Troubleshooting

### Common Issues

1. **Router Lambda not triggering**
   - Check MSK event source mapping status
   - Verify IAM permissions for Kafka cluster access
   - Check VPC security group rules

2. **Messages not reaching SQS**
   - Verify SNS subscription filter policy matches challengeId
   - Check SNS publish permissions

3. **ECS Task not launching**
   - Verify task definition exists
   - Check subnet and security group configuration
   - Verify IAM PassRole permissions

4. **Completion Lambda not receiving events**
   - Verify EventBridge rule pattern matches
   - Check task family prefix filter
   - Verify Lambda invoke permissions

### Log Queries

#### Find errors in Router Lambda
```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/mm-router-lambda \
  --filter-pattern "ERROR"
```

#### Find failed ECS tasks
```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/mm-completion-lambda \
  --filter-pattern "FAILED"
```

## Performance Validation

### Lambda Cold Start Times

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/mm-challenge-challenge-1-lambda \
  --filter-pattern "REPORT RequestId" \
  | grep "Init Duration"
```

### SQS Queue Depth

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/SQS \
  --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value=mm-challenge-1-queue \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 300 \
  --statistics Average
```

### ECS Task Duration

Monitor via ECS console or CloudWatch Container Insights.
