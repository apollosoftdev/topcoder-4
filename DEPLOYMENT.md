# Match Scorer AWS Deployment Guide

Complete guide for deploying the Match Scorer application to AWS using AWS CDK.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Account Setup](#account-setup)
- [Bootstrap CDK Environment](#bootstrap-cdk-environment)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Verification](#verification)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Updates and Maintenance](#updates-and-maintenance)
- [Cleanup](#cleanup)

---

## Architecture Overview

The Match Scorer system uses a **fan-out architecture** for scalable, per-challenge processing:

- **VPC**: Custom VPC with public and private subnets across 2 AZs
- **MSK Cluster**: Managed Kafka cluster for submission event streaming
- **SNS Topic**: Fan-out hub for submission messages
- **SQS Queues**: Per-challenge queues with dead-letter queues
- **DynamoDB**: Challenge-to-queue mapping table
- **ECS Fargate**: Container service running Java scoring engine
- **ECR**: Docker image repository for scorer container
- **Lambda Functions**:
  - `RouterLambda`: MSK → SNS router with validation
  - `ChallengeProcessor-{Name}`: SQS → ECS launcher (one per challenge)
  - `CompletionLambda`: EventBridge → CloudWatch task completion handler
  - `SubmissionWatcherLambda`: Legacy direct MSK → ECS (kept for reference)
- **EventBridge**: ECS task state change rules
- **CloudWatch Logs**: Centralized logging for all services
- **SSM Parameter Store**: Configuration management for challenges and scorers

**Data Flow (Fan-Out)**:
```
MSK → Router Lambda → SNS Topic → SQS Queues → Challenge Lambdas → ECS Tasks
                          ↓                                           ↓
                     DynamoDB                                   EventBridge
                    (validation)                                     ↓
                                                            Completion Lambda
```

---

## Prerequisites

### Required Tools

1. **AWS CLI** (v2.x or higher)
   ```bash
   aws --version
   # Should show: aws-cli/2.x.x or higher
   ```

2. **Node.js** (v20.x)
   ```bash
   node --version
   # Should show: v20.x.x
   ```

3. **npm** (comes with Node.js)
   ```bash
   npm --version
   ```

4. **AWS CDK CLI** (v2.x)
   ```bash
   npm install -g aws-cdk
   cdk --version
   # Should show: 2.x.x
   ```

5. **Docker** (for building ECS images)
   ```bash
   docker --version
   # Docker must be running
   ```

6. **Java JDK** (11 or higher, for local development only)
   ```bash
   java -version
   ```

7. **Maven** (for Java builds, if modifying scorer)
   ```bash
   mvn --version
   ```

### AWS Account Requirements

- **IAM Permissions**: Administrator access or equivalent permissions for:
  - CloudFormation
  - IAM (role/policy creation)
  - VPC, EC2, Security Groups
  - MSK (Managed Streaming for Kafka)
  - ECS, ECR
  - Lambda
  - CloudWatch Logs
  - SSM Parameter Store
  - S3 (for CDK assets)

- **Service Quotas**: Ensure adequate limits for:
  - VPCs (default: 5 per region)
  - NAT Gateways (default: 5 per AZ)
  - MSK Clusters (default: 10 per region)
  - ECS Fargate tasks (default: 100 concurrent tasks)

- **Region**: All resources will be deployed to **us-east-1** (configurable)

---

## Account Setup

### 1. Configure AWS CLI Credentials

Set up your AWS credentials for the target account:

```bash
# Option 1: Using AWS configure
aws configure
# Enter: Access Key ID, Secret Access Key, us-east-1, json

# Option 2: Using environment variables
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"
export AWS_DEFAULT_REGION="us-east-1"

# Option 3: Using AWS profiles
aws configure --profile match-scorer-dev
export AWS_PROFILE=match-scorer-dev
```

Verify credentials:
```bash
aws sts get-caller-identity
# Should return your account ID and user/role ARN
```

### 2. Set Required Permissions

Ensure your IAM user/role has sufficient permissions. Minimum required:
- `AdministratorAccess` (recommended for initial setup)
- OR custom policy with permissions for all services mentioned above

---

## Bootstrap CDK Environment

CDK requires a one-time bootstrap process to create necessary infrastructure (S3 buckets, IAM roles, ECR repositories) for deployments.

### Bootstrap Options

#### Option 1: Standard Bootstrap (Recommended for Most Users)

```bash
cd codebase/cdk

# Bootstrap with default settings
cdk bootstrap aws://ACCOUNT-ID/us-east-1

# Example:
# cdk bootstrap aws://123456789012/us-east-1
```

#### Option 2: Custom Bootstrap (For Enterprise/Multi-Account)

If you need custom configurations (custom S3 bucket names, cross-account access, etc.):

```bash
cd codebase/cdk

# Using the custom bootstrap template
cdk bootstrap aws://ACCOUNT-ID/us-east-1 \
  --template bootstrap-custom.yaml \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

#### Option 3: Manual Bootstrap (Advanced)

For maximum control or environments with restrictions:

```bash
cd codebase/cdk
chmod +x manual-bootstrap.sh
./manual-bootstrap.sh ACCOUNT-ID us-east-1
```

### Verify Bootstrap

Check that bootstrap stack was created:

```bash
aws cloudformation describe-stacks \
  --stack-name CDKToolkit \
  --region us-east-1 \
  --query "Stacks[0].StackStatus"
# Should return: "CREATE_COMPLETE" or "UPDATE_COMPLETE"
```

---

## Configuration

> 📖 **For detailed infrastructure configuration (existing MSK/VPC vs new), see [INFRASTRUCTURE_CONFIG.md](INFRASTRUCTURE_CONFIG.md)**

### 1. Clone and Navigate to Project

```bash
git clone <repository-url>
cd mm-new-scorer/codebase/cdk
```

### 2. Install Dependencies

```bash
# From project root - installs all workspaces
npm install

# This installs dependencies for:
# - cdk/
# - router-lambda/
# - challenge-processor-lambda/
# - completion-lambda/
# - submission-watcher-lambda/
# - test-data-sender-lambda/
```

### 3. Configure Environment Variables

The application uses environment variables for runtime configuration. Create a `.env` file in the **project root**:

```bash
# Copy the example file
cp .env.example .env

# Edit with your values
nano .env  # or use your preferred editor
```

#### Infrastructure Configuration (MSK & VPC)

**Using Existing Infrastructure** (Recommended if you already have MSK and VPC):

```bash
# In your .env file:
EXISTING_MSK_CLUSTER_ARN="arn:aws:kafka:us-east-1:123456789012:cluster/your-msk-cluster/uuid"
EXISTING_VPC_ID="vpc-0123456789abcdef0"
```

**⚠️ Important Notes:**
- If you set `EXISTING_MSK_CLUSTER_ARN`, the stack will **NOT** create a new MSK cluster
- If you set `EXISTING_VPC_ID`, the stack will **NOT** create a new VPC
- Make sure the VPC has both public and private subnets
- The MSK cluster must be in the same VPC or accessible from it
- The MSK security group must allow connections from Lambda and ECS

**Creating New Infrastructure** (if you don't have MSK and VPC):

If you don't set these environment variables, CDK will create new MSK cluster and VPC automatically:

```bash
# Optional: Customize names for new resources
export MSK_CLUSTER_NAME="match-scorer"
export VPC_NAME="match-scorer-vpc"  # Currently not configurable, will use default
```

#### Required Variables

```bash
# Auth0 M2M Configuration (REQUIRED)
export AUTH0_CLIENT_ID="your-auth0-client-id"
export AUTH0_CLIENT_SECRET="your-auth0-client-secret"

# Optional: Override defaults if needed
export AUTH0_URL="https://topcoder-dev.auth0.com/oauth/token"
export AUTH0_AUDIENCE="https://m2m.topcoder-dev.com/"
export AUTH0_PROXY_URL="https://auth0proxy.topcoder-dev.com/token"
```

#### Optional Variables (with defaults)

```bash
# API Configuration
export SUBMISSION_API_URL="https://api.topcoder-dev.com/v6"
export REVIEW_SCORECARD_ID="30001852"
export REVIEW_TYPE_NAME="MMScorer"

# Infrastructure Names
export MSK_CLUSTER_NAME="match-scorer"
export ECS_CLUSTER_NAME="match-scorer-ecs-cluster"
export LOG_GROUP_NAME="/ecs/match-scorer"

# Lambda Settings
export TASK_TIMEOUT_SECONDS="60"
export MAX_RETRIES="3"

# Logging
export LOG_LEVEL="debug"

# Fan-Out Architecture Configuration
export SNS_TOPIC_NAME="submission-fanout-topic"
export CHALLENGE_MAPPING_TABLE_NAME="challenge-queue-mapping"
export ECS_TASK_STATE_RULE_NAME="ecs-task-state-change-rule"
export SQS_VISIBILITY_TIMEOUT_SECONDS="120"
export SQS_MESSAGE_RETENTION_DAYS="7"
export SQS_MAX_RECEIVE_COUNT="3"
export DLQ_RETENTION_DAYS="14"

# Challenge Configuration (JSON array)
export CHALLENGES='[{"challengeId":"your-challenge-uuid","challengeName":"YourChallenge"}]'
```

### 4. Environment-Specific Configuration

For **development**:
```bash
export AUTH0_CLIENT_ID="nMg1e9r7Cnrsw4Zf2zrfM8lvhttFHBmR"
export AUTH0_CLIENT_SECRET="<dev-secret>"
export SUBMISSION_API_URL="https://api.topcoder-dev.com/v6"
```

For **production**:
```bash
export AUTH0_CLIENT_ID="<prod-client-id>"
export AUTH0_CLIENT_SECRET="<prod-secret>"
export SUBMISSION_API_URL="https://api.topcoder.com/v6"
export LOG_LEVEL="info"
```

### 5. Challenge Configuration

Challenge and scorer configurations are stored in **SSM Parameter Store** and automatically created during deployment. Default configuration (in `lib/config.ts`):

- **Challenge ID**: `30096756` (Marathon Match 160)
- **Scorer**: `BioSlime`
- **Parameter Paths**:
  - Challenge: `/scorer/challenges/30096756/config`
  - Scorer: `/scorer/challenges/30096756/scorers/BioSlime/config`

To add new challenges after deployment, see [Adding New Challenges](#adding-new-challenges).

---

## Deployment

### 1. Build the CDK Application

```bash
cd codebase/cdk
npm run build
```

This compiles TypeScript to JavaScript and validates CDK constructs.

### 2. Review Changes (Optional but Recommended)

Preview what will be created/updated:

```bash
cdk diff MatchScorerStack
```

Review the output for:
- New resources being created
- Existing resources being modified
- IAM permissions being granted
- Security group rules

### 3. Deploy to AWS

#### First-Time Deployment

**⚠️ WARNING**: First deployment takes **25-35 minutes** due to MSK cluster creation.

```bash
# Deploy with auto-approval (no prompts)
npm run deploy

# OR deploy with confirmation prompts
cdk deploy MatchScorerStack

# OR with specific region/account
cdk deploy MatchScorerStack \
  --region us-east-1 \
  --require-approval never
```

#### Subsequent Deployments

Updates are much faster (5-10 minutes):

```bash
npm run deploy
```

### 4. Deployment Progress

Monitor the CloudFormation stack in the AWS Console:

1. Open AWS Console → CloudFormation
2. Select region: **us-east-1**
3. Find stack: **MatchScorerStack**
4. Click "Events" tab to see progress

Or watch from CLI:
```bash
watch -n 10 'aws cloudformation describe-stack-events \
  --stack-name MatchScorerStack \
  --region us-east-1 \
  --max-items 10 \
  --query "StackEvents[].[Timestamp,ResourceStatus,ResourceType,LogicalResourceId]" \
  --output table'
```

### 5. Capture Outputs

After deployment completes, CDK will display important outputs:

```
Outputs:
MatchScorerStack.EcsClusterArn = arn:aws:ecs:us-east-1:123456789012:cluster/match-scorer-ecs-cluster
MatchScorerStack.EcsTaskDefinitionArn = arn:aws:ecs:us-east-1:123456789012:task-definition/...
MatchScorerStack.WatcherLambdaFunctionArn = arn:aws:lambda:us-east-1:123456789012:function:SubmissionWatcherLambda
MatchScorerStack.EcrRepositoryUri = 123456789012.dkr.ecr.us-east-1.amazonaws.com/cdk-hnb659fds-container-assets-...
MatchScorerStack.MskClusterArnOutput = arn:aws:kafka:us-east-1:123456789012:cluster/match-scorer/...

# Fan-Out Architecture Outputs:
MatchScorerStack.DynamoDbTableName = challenge-queue-mapping
MatchScorerStack.SnsTopicArn = arn:aws:sns:us-east-1:123456789012:submission-fanout-topic
MatchScorerStack.RouterLambdaFunctionArn = arn:aws:lambda:us-east-1:123456789012:function:RouterLambda
MatchScorerStack.CompletionLambdaFunctionArn = arn:aws:lambda:us-east-1:123456789012:function:CompletionLambda
MatchScorerStack.EventBridgeRuleName = ecs-task-state-change-rule
MatchScorerStack.DynamoDBSeedCommand = aws dynamodb put-item ...
```

**💡 TIP**: Save these outputs for troubleshooting and operations.

### 6. Seed DynamoDB Table

After deployment, seed the DynamoDB table with challenge-queue mappings:

```bash
# Use the DynamoDBSeedCommand from stack outputs, or manually:
aws dynamodb put-item \
  --table-name challenge-queue-mapping \
  --item '{
    "challengeId": {"S": "your-challenge-uuid"},
    "queueUrl": {"S": "https://sqs.us-east-1.amazonaws.com/123456789012/challenge-yourchallenge-queue"},
    "queueArn": {"S": "arn:aws:sqs:us-east-1:123456789012:challenge-yourchallenge-queue"},
    "dlqUrl": {"S": "https://sqs.us-east-1.amazonaws.com/123456789012/challenge-yourchallenge-dlq"},
    "challengeName": {"S": "YourChallenge"},
    "active": {"BOOL": true},
    "createdAt": {"S": "2024-01-01T00:00:00Z"},
    "updatedAt": {"S": "2024-01-01T00:00:00Z"}
  }' \
  --region us-east-1
```

---

## Verification

### 1. Verify Infrastructure Components

#### Check Lambda Functions

```bash
aws lambda list-functions \
  --region us-east-1 \
  --query "Functions[?contains(FunctionName,'SubmissionWatcherLambda')].{Name:FunctionName,Runtime:Runtime,State:State}" \
  --output table
```

Expected output: 1 function with `State: Active`

#### Check ECS Cluster

```bash
aws ecs describe-clusters \
  --clusters match-scorer-ecs-cluster \
  --region us-east-1 \
  --query "clusters[0].{Name:clusterName,Status:status,Tasks:registeredContainerInstancesCount}" \
  --output table
```

#### Check MSK Cluster

```bash
aws kafka list-clusters \
  --region us-east-1 \
  --query "ClusterInfoList[?ClusterName=='match-scorer'].{Name:ClusterName,State:State}" \
  --output table
```

Expected state: `ACTIVE`

#### Check ECR Repository

```bash
aws ecr describe-repositories \
  --region us-east-1 \
  --query "repositories[?contains(repositoryName,'cdk-hnb659fds')].{Name:repositoryName,URI:repositoryUri}" \
  --output table
```

#### Check Docker Image

```bash
# Get repository name from outputs
REPO_NAME=$(aws ecr describe-repositories \
  --region us-east-1 \
  --query "repositories[?contains(repositoryName,'container-assets')].repositoryName" \
  --output text)

# List images
aws ecr list-images \
  --repository-name "$REPO_NAME" \
  --region us-east-1 \
  --output table
```

Should show at least one image with tags.

### 2. Verify Parameter Store Configuration

```bash
# List all scorer parameters
aws ssm get-parameters-by-path \
  --path "/scorer" \
  --recursive \
  --region us-east-1 \
  --query "Parameters[].{Name:Name,Type:Type}" \
  --output table
```

Expected parameters:
- `/scorer/challenges/30096756/config`
- `/scorer/challenges/30096756/scorers/BioSlime/config`

View parameter values:
```bash
# Challenge config
aws ssm get-parameter \
  --name "/scorer/challenges/30096756/config" \
  --region us-east-1 \
  --query "Parameter.Value" \
  --output text | jq .

# Scorer config
aws ssm get-parameter \
  --name "/scorer/challenges/30096756/scorers/BioSlime/config" \
  --region us-east-1 \
  --query "Parameter.Value" \
  --output text | jq .
```

### 3. Check Lambda Event Source Mapping

```bash
aws lambda list-event-source-mappings \
  --function-name SubmissionWatcherLambda \
  --region us-east-1 \
  --query "EventSourceMappings[].{State:State,Topics:Topics,LastProcessingResult:LastProcessingResult}" \
  --output table
```

Expected:
- `State: Enabled` or `Enabling`
- `Topics: ["submission.notification.create"]`
- `LastProcessingResult: OK` or `No records processed` (initial state)

### 4. Verify VPC and Networking

```bash
# Check VPC
aws ec2 describe-vpcs \
  --filters "Name=tag:Name,Values=*MatchScorerStack*" \
  --region us-east-1 \
  --query "Vpcs[].{VpcId:VpcId,CIDR:CidrBlock,State:State}" \
  --output table

# Check Subnets
aws ec2 describe-subnets \
  --filters "Name=tag:Name,Values=*MatchScorerStack*" \
  --region us-east-1 \
  --query "Subnets[].{SubnetId:SubnetId,Type:Tags[?Key=='aws-cdk:subnet-type'].Value|[0],AZ:AvailabilityZone}" \
  --output table
```

Expected: 2 public + 2 private subnets across 2 AZs

---

## Testing

### 1. Monitor SubmissionWatcherLambda Logs

**Real-time log streaming**:
```bash
aws logs tail /aws/lambda/SubmissionWatcherLambda \
  --region us-east-1 \
  --follow \
  --since 10m
```

Expected log entries:
```
START RequestId: ... Version: $LATEST
Received event: { ... }
Processing 1 Kafka records from submission.notification.create
Setting submission status to 'submitted' for submission: ...
Fetching Auth0 token...
Auth0 token fetched successfully
Starting ECS scoring task...
ECS task started: arn:aws:ecs:us-east-1:...
END RequestId: ...
```

**Query recent invocations**:
```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/SubmissionWatcherLambda \
  --start-time $(date -u -d '30 minutes ago' +%s)000 \
  --region us-east-1 \
  --filter-pattern "Received event" \
  --query "events[].[timestamp,message]" \
  --output table
```

### 2. Verify ECS Task Execution

**List running tasks**:
```bash
aws ecs list-tasks \
  --cluster match-scorer-ecs-cluster \
  --region us-east-1 \
  --desired-status RUNNING
```

**List recently stopped tasks**:
```bash
aws ecs list-tasks \
  --cluster match-scorer-ecs-cluster \
  --region us-east-1 \
  --desired-status STOPPED \
  --max-results 10
```

**Get task details**:
```bash
# Replace TASK_ID with actual task ID
aws ecs describe-tasks \
  --cluster match-scorer-ecs-cluster \
  --tasks TASK_ID \
  --region us-east-1 \
  --query "tasks[0].{Status:lastStatus,StopCode:stopCode,StopReason:stoppedReason,ExitCode:containers[0].exitCode}"
```

**View ECS task logs**:
```bash
# Find log stream name (format: ecs/MatchScorerContainer/{task-id})
aws logs describe-log-streams \
  --log-group-name /ecs/match-scorer \
  --region us-east-1 \
  --order-by LastEventTime \
  --descending \
  --max-items 5

# Tail logs from latest task
LOG_STREAM=$(aws logs describe-log-streams \
  --log-group-name /ecs/match-scorer \
  --region us-east-1 \
  --order-by LastEventTime \
  --descending \
  --max-items 1 \
  --query "logStreams[0].logStreamName" \
  --output text)

aws logs get-log-events \
  --log-group-name /ecs/match-scorer \
  --log-stream-name "$LOG_STREAM" \
  --region us-east-1 \
  --query "events[].[timestamp,message]" \
  --output table
```

### 3. End-to-End Test

**Complete test scenario**:

To test the system, you need to publish a message to the Kafka topic `submission.notification.create`. This can be done through:

1. **External Kafka Producer**: Use a Kafka client to publish test messages directly to the MSK cluster
2. **Topcoder Submission API**: Trigger real submission events that publish to the topic
3. **Manual Testing**: Use AWS CLI or Kafka console producer tools

**Expected Flow**:
1. Message published to Kafka topic `submission.notification.create`
2. `SubmissionWatcherLambda` consumes the message via Event Source Mapping
3. Lambda triggers ECS Fargate task to run the scorer
4. Scorer processes submission and updates Topcoder API

**Verify the flow**:
```bash
# Check Watcher Lambda logs for recent activity
aws logs filter-log-events \
  --log-group-name /aws/lambda/SubmissionWatcherLambda \
  --start-time $(date -u -d '30 minutes ago' +%s)000 \
  --region us-east-1 \
  --filter-pattern "ECS task started"

# Check ECS tasks
aws ecs list-tasks \
  --cluster match-scorer-ecs-cluster \
  --region us-east-1 \
  --desired-status STOPPED \
  --max-results 5

# Verify scorer logs
aws logs tail /ecs/match-scorer \
  --region us-east-1 \
  --since 10m
```

---

## Troubleshooting

### Common Issues

#### 1. Bootstrap Errors

**Error**: `CDKToolkit stack doesn't exist`

```bash
# Solution: Bootstrap the environment
cdk bootstrap aws://ACCOUNT-ID/us-east-1
```

**Error**: `Unable to resolve AWS account to use`

```bash
# Solution: Set explicit region/account in bin/match-scorer-cdk.ts
env: { account: '123456789012', region: 'us-east-1' }
```

#### 2. Docker/ECR Issues

**Error**: `Cannot connect to the Docker daemon`

```bash
# Solution: Start Docker Desktop or Docker service
# macOS/Windows: Start Docker Desktop
# Linux:
sudo systemctl start docker
```

**Error**: `ECR: Authentication token expired`

```bash
# Solution: Re-authenticate with ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  123456789012.dkr.ecr.us-east-1.amazonaws.com
```

#### 3. MSK Connection Issues

**Error**: Lambda cannot connect to MSK

```bash
# Check security groups
aws ec2 describe-security-groups \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=MatchScorerStack" \
  --region us-east-1 \
  --query "SecurityGroups[].{ID:GroupId,Name:GroupName,Ingress:IpPermissions}"

# Verify Lambda is in private subnets
aws lambda get-function-configuration \
  --function-name SubmissionWatcherLambda \
  --region us-east-1 \
  --query "VpcConfig.SubnetIds"
```

#### 4. Lambda Permission Errors

**Error**: `Access denied` when Lambda invokes ECS

```bash
# Check Lambda execution role
aws iam get-role-policy \
  --role-name MatchScorerStack-SubmissionWatcherLambdaWatcher... \
  --policy-name default \
  --region us-east-1

# Verify ECS task role has required permissions
aws iam list-attached-role-policies \
  --role-name MatchScorerStack-EcsConstructTaskRole... \
  --region us-east-1
```

#### 5. Auth0 Token Errors

**Error**: `401 Unauthorized` or `Invalid token`

```bash
# Check Auth0 environment variables
aws lambda get-function-configuration \
  --function-name SubmissionWatcherLambda \
  --region us-east-1 \
  --query "Environment.Variables.{URL:AUTH0_URL,ClientId:AUTH0_CLIENT_ID}"

# Test token retrieval manually
curl -X POST https://topcoder-dev.auth0.com/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "client_credentials",
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET",
    "audience": "https://m2m.topcoder-dev.com/"
  }'
```

#### 6. Parameter Store Issues

**Error**: Parameter not found

```bash
# List all parameters
aws ssm get-parameters-by-path \
  --path "/scorer" \
  --recursive \
  --region us-east-1

# Manually create missing parameter
aws ssm put-parameter \
  --name "/scorer/challenges/30096756/config" \
  --value '{"name":"Marathon Match 160",...}' \
  --type String \
  --region us-east-1
```

### Debugging Commands

**Check CloudFormation stack events**:
```bash
aws cloudformation describe-stack-events \
  --stack-name MatchScorerStack \
  --region us-east-1 \
  --max-items 20 \
  --query "StackEvents[?ResourceStatus=='CREATE_FAILED' || ResourceStatus=='UPDATE_FAILED'].{Time:Timestamp,Resource:LogicalResourceId,Status:ResourceStatus,Reason:ResourceStatusReason}" \
  --output table
```

**Get stack outputs**:
```bash
aws cloudformation describe-stacks \
  --stack-name MatchScorerStack \
  --region us-east-1 \
  --query "Stacks[0].Outputs" \
  --output table
```

**View all Lambda environment variables**:
```bash
aws lambda get-function-configuration \
  --function-name SubmissionWatcherLambda \
  --region us-east-1 \
  --query "Environment.Variables"
```

**Check Lambda logs for errors**:
```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/SubmissionWatcherLambda \
  --start-time $(date -u -d '1 hour ago' +%s)000 \
  --region us-east-1 \
  --filter-pattern "ERROR"
```

---

## Updates and Maintenance

### Updating Application Code

#### Update Lambda Functions

1. Modify Lambda code in `submission-watcher-lambda/`
2. Deploy changes:

```bash
cd codebase/cdk
npm run build
npm run deploy
```

CDK automatically packages and uploads new Lambda code.

#### Update ECS Scorer

1. Modify Java code in `java-scorer/src/`
2. Build locally (optional, CDK builds automatically):

```bash
cd java-scorer
mvn clean package
```

3. Deploy with Docker rebuild:

```bash
cd ../cdk
npm run build
npm run deploy
```

CDK builds new Docker image and pushes to ECR automatically.

### Updating Infrastructure

#### Update CDK Code

1. Modify constructs in `cdk/lib/`
2. Preview changes:

```bash
npm run build
cdk diff MatchScorerStack
```

3. Deploy:

```bash
npm run deploy
```

#### Update CDK Version

```bash
cd codebase/cdk

# Update CDK CLI
npm install -g aws-cdk@latest

# Update CDK libraries
npm update aws-cdk-lib aws-cdk

# Rebuild and deploy
npm run build
npm run deploy
```

### Adding New Challenges

**Option 1: Via CDK** (requires redeployment)

Edit `cdk/lib/config.ts`:

```typescript
export const devChallenges = [
  {
    challengeId: '30096756',
    name: 'Marathon Match 160',
    scorers: ['BioSlime']
  },
  {
    challengeId: '30096757',  // New challenge
    name: 'Marathon Match 161',
    scorers: ['NewScorer']
  }
];
```

Redeploy:
```bash
npm run build
npm run deploy
```

**Option 2: Via AWS CLI** (no redeployment needed)

```bash
# Create challenge config
aws ssm put-parameter \
  --name "/scorer/challenges/30096757/config" \
  --value '{
    "name": "Marathon Match 161",
    "active": true,
    "scorers": ["NewScorer"],
    "submissionApiUrl": "https://api.topcoder-dev.com/v6",
    "reviewScorecardId": "30001852",
    "reviewTypeName": "MMScorer"
  }' \
  --type String \
  --region us-east-1

# Create scorer config
aws ssm put-parameter \
  --name "/scorer/challenges/30096757/scorers/NewScorer/config" \
  --value '{
    "name": "NewScorer",
    "testerClass": "com.topcoder.challenges.mm161.NewScorerTester",
    "timeLimit": 10000,
    "timeout": 10000,
    "compileTimeout": 10000,
    "startSeed": 42,
    "numberOfTests": 1,
    "phases": [...]
  }' \
  --type String \
  --region us-east-1
```

### Scaling Configuration

#### Scale ECS Tasks

Edit `cdk/lib/ecs-construct.ts`:

```typescript
cpu: '2048',      // Change from 1024 (1 vCPU to 2 vCPU)
memoryMiB: '4096' // Change from 2048 (2GB to 4GB)
```

#### Scale MSK Cluster

Edit `cdk/lib/msk-construct.ts`:

```typescript
numberOfBrokerNodes: 3  // Change from 2
brokerNodeGroupInfo: {
  instanceType: 'kafka.m5.large'  // Upgrade instance type
}
```

#### Adjust Lambda Concurrency

```bash
# Set reserved concurrent executions
aws lambda put-function-concurrency \
  --function-name SubmissionWatcherLambda \
  --reserved-concurrent-executions 10 \
  --region us-east-1
```

---

## Cleanup

### Delete All Resources

**⚠️ WARNING**: This will permanently delete all resources and data.

```bash
cd codebase/cdk

# Destroy stack
npm run destroy

# OR with confirmation prompt
cdk destroy MatchScorerStack --region us-east-1
```

### Manual Cleanup (if CDK destroy fails)

1. **Delete CloudFormation stack manually**:
```bash
aws cloudformation delete-stack \
  --stack-name MatchScorerStack \
  --region us-east-1
```

2. **Delete ECR images** (if repository deletion fails):
```bash
REPO_NAME=$(aws ecr describe-repositories \
  --region us-east-1 \
  --query "repositories[?contains(repositoryName,'container-assets')].repositoryName" \
  --output text)

aws ecr batch-delete-image \
  --repository-name "$REPO_NAME" \
  --region us-east-1 \
  --image-ids "$(aws ecr list-images --repository-name "$REPO_NAME" --region us-east-1 --query 'imageIds[*]' --output json)"
```

3. **Delete S3 assets** (CDK staging bucket):
```bash
BUCKET_NAME=$(aws s3 ls | grep cdk-hnb659fds-assets | awk '{print $3}')

aws s3 rm s3://$BUCKET_NAME --recursive
aws s3 rb s3://$BUCKET_NAME
```

4. **Delete CloudWatch logs**:
```bash
aws logs delete-log-group \
  --log-group-name /aws/lambda/SubmissionWatcherLambda \
  --region us-east-1

aws logs delete-log-group \
  --log-group-name /ecs/match-scorer \
  --region us-east-1
```

5. **Delete SSM parameters**:
```bash
aws ssm delete-parameters \
  --names $(aws ssm get-parameters-by-path \
    --path "/scorer" \
    --recursive \
    --region us-east-1 \
    --query "Parameters[].Name" \
    --output text) \
  --region us-east-1
```

### Cost Estimation

**Estimated Monthly Costs** (us-east-1, moderate usage):

- **MSK Cluster** (2x kafka.m5.large, 24/7): ~$300/month
- **NAT Gateway** (2 AZs, 24/7): ~$64/month
- **ECS Fargate** (1 vCPU, 2GB, 100 tasks/day @ 10min each): ~$12/month
- **Lambda** (1000 invocations/day): <$1/month (mostly free tier)
- **CloudWatch Logs** (5GB/month): ~$2.50/month
- **ECR Storage** (10GB): ~$1/month
- **Data Transfer**: Variable (~$5-20/month)

**Total**: ~$385-405/month

**Cost Optimization Tips**:
- Use MSK Serverless instead of provisioned (reduce ~50%)
- Delete NAT Gateways if outbound internet not needed
- Use CloudWatch Logs retention policies
- Schedule MSK cluster stop/start for non-prod environments

---

## Support

### Documentation References

- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [AWS MSK Documentation](https://docs.aws.amazon.com/msk/)
- [AWS ECS Fargate Documentation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [AWS Lambda Documentation](https://docs.aws.amazon.com/lambda/)

### Additional Resources

- **Architecture Diagram**: `codebase/architecture.md`
- **Kafka Discovery**: `KAFKA_ADDRESS_DISCOVERY.md`
- **Parameter Store Guide**: `AWS_PARAMETER_STORE_GUIDE.md`
- **Validation Guide**: `VALIDATION.md`
- **README**: `codebase/README.md`

### Contact

For issues or questions, contact the development team or create an issue in the repository.

---

**Last Updated**: 2026-01-09  
**Version**: 1.0.0
