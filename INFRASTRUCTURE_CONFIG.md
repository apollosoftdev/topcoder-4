# Infrastructure Configuration Guide

This guide explains how to configure the Match Scorer application to use **existing MSK and VPC** or create new ones.

---

## Configuration Modes

### Mode 1: Use Existing MSK and VPC (Recommended)

If you already have an MSK cluster and VPC, you can reuse them instead of creating new ones.

#### Prerequisites

1. **Existing MSK Cluster**
   - Kafka version: 3.4.0 or compatible
   - Security group allows inbound on port 9094 (TLS)
   - Located in the same AWS account and region
   
2. **Existing VPC**
   - Has both public and private subnets
   - At least 2 availability zones
   - NAT Gateway or VPC endpoints for private subnet internet access
   - MSK cluster is accessible from this VPC

#### Configuration Steps

1. **Get MSK Cluster ARN**:
   ```bash
   aws kafka list-clusters --region us-east-1
   
   # Copy the ARN from output (format: arn:aws:kafka:region:account:cluster/name/uuid)
   ```

2. **Get VPC ID**:
   ```bash
   aws ec2 describe-vpcs --region us-east-1
   
   # Find your VPC and copy the VPC ID (format: vpc-xxxxxxxxxxxx)
   ```

3. **Get Subnet IDs** (optional but recommended):
   ```bash
   # List all subnets in your VPC
   aws ec2 describe-subnets \
     --filters "Name=vpc-id,Values=vpc-xxxxxxxx" \
     --region us-east-1 \
     --query "Subnets[].{ID:SubnetId,AZ:AvailabilityZone,Type:Tags[?Key=='Name'].Value|[0]}"
   
   # Separate public and private subnet IDs
   ```

4. **Get Security Group IDs** (optional):
   ```bash
   # List security groups in your VPC
   aws ec2 describe-security-groups \
     --filters "Name=vpc-id,Values=vpc-xxxxxxxx" \
     --region us-east-1 \
     --query "SecurityGroups[].{ID:GroupId,Name:GroupName}"
   ```

5. **Set Environment Variables**:
   ```bash
   cd codebase/cdk
   
   # Copy example config
   cp .env.example .env
   
   # Edit .env file and set:
   export EXISTING_MSK_CLUSTER_ARN="arn:aws:kafka:us-east-1:123456789012:cluster/your-cluster/uuid"
   export EXISTING_VPC_ID="vpc-0123456789abcdef0"
   
   # Optional: Specify exact subnets to use
   export EXISTING_PRIVATE_SUBNET_IDS="subnet-priv1,subnet-priv2"
   
   # Optional: Specify security groups for Lambda/ECS
   export EXISTING_SECURITY_GROUP_IDS="sg-xxxxxxxx,sg-yyyyyyyy"
   
   # Required: Auth0 credentials
   export AUTH0_CLIENT_ID="your-client-id"
   export AUTH0_CLIENT_SECRET="your-secret"
   
   # Load variables
   source .env
   ```

**Configuration Levels**:

You can configure at different levels of granularity:

1. **VPC Only**: Specify VPC ID, use auto-discovered subnets
   ```bash
   export EXISTING_VPC_ID="vpc-xxx"
   # Subnets will be auto-discovered from VPC
   ```

2. **VPC + Subnets**: Specify VPC and exact subnets
   ```bash
   export EXISTING_VPC_ID="vpc-xxx"
   export EXISTING_PRIVATE_SUBNET_IDS="subnet-priv1,subnet-priv2"
   ```

3. **VPC + Subnets + Security Groups**: Full control
   ```bash
   export EXISTING_VPC_ID="vpc-xxx"
   export EXISTING_PRIVATE_SUBNET_IDS="subnet-priv1,subnet-priv2"
   export EXISTING_SECURITY_GROUP_IDS="sg-xxx,sg-yyy"
   ```

4. **Security Group Configuration**:
   
   **VPC Default Security Group (Automatic)**
   ```bash
   # No configuration needed - Lambda and MSK automatically communicate
   # via VPC default security group
   
   # Optional: Verify VPC default security group allows internal communication
   VPC_ID="vpc-xxxxxxxx"
   DEFAULT_SG=$(aws ec2 describe-security-groups \
     --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=default" \
     --query "SecurityGroups[0].GroupId" --output text)
   
   echo "VPC Default Security Group: $DEFAULT_SG"
   
   # Should have a rule allowing traffic from itself (internal VPC communication)
   aws ec2 describe-security-groups --group-ids "$DEFAULT_SG"
   ```

5. **Deploy**:
   ```bash
   npm run build
   npm run deploy
   ```

#### What Gets Created

When using existing infrastructure, CDK will **only** create:
- ✅ ECS Cluster and Task Definition
- ✅ Lambda Functions (SubmissionWatcherLambda)
- ✅ CloudWatch Log Groups
- ✅ IAM Roles and Policies
- ✅ ECR Repository for Docker images
- ✅ SSM Parameters

CDK will **NOT** create:
- ❌ MSK Cluster (using your existing one)
- ❌ VPC (using your existing one)
- ❌ NAT Gateways (using your existing VPC's)
- ❌ MSK Security Group (using existing cluster's SG)

**Estimated deployment time**: 8-12 minutes (vs 25-35 minutes with new MSK)

**Estimated monthly cost**: ~$80-100 (vs ~$385-405 with new MSK)

---

### Mode 2: Create New MSK and VPC

If you don't have existing infrastructure, CDK will create everything.

#### Configuration Steps

1. **Set Required Variables Only**:
   ```bash
   cd codebase/cdk
   
   # Only set Auth0 credentials
   export AUTH0_CLIENT_ID="your-client-id"
   export AUTH0_CLIENT_SECRET="your-secret"
   
   # Optional: Customize names
   export MSK_CLUSTER_NAME="match-scorer"
   export ECS_CLUSTER_NAME="match-scorer-ecs-cluster"
   ```

2. **Do NOT set these**:
   ```bash
   # Leave these UNSET to create new resources
   # EXISTING_MSK_CLUSTER_ARN=...  # Don't set this
   # EXISTING_VPC_ID=...           # Don't set this
   ```

3. **Deploy**:
   ```bash
   npm run build
   npm run deploy
   ```

#### What Gets Created

CDK will create **all** resources:
- ✅ VPC with public and private subnets (2 AZs)
- ✅ NAT Gateway
- ✅ MSK Cluster (2 brokers, kafka.t3.small)
- ✅ MSK Security Group
- ✅ ECS Cluster and Task Definition
- ✅ Lambda Functions
- ✅ CloudWatch Log Groups
- ✅ IAM Roles and Policies
- ✅ ECR Repository
- ✅ SSM Parameters

**Estimated deployment time**: 25-35 minutes (MSK creation is slow)

**Estimated monthly cost**: ~$385-405

---

## Hybrid Configuration

You can mix and match existing and new resources:

### Use Existing VPC + Create New MSK

```bash
export EXISTING_VPC_ID="vpc-0123456789abcdef0"
# Don't set EXISTING_MSK_CLUSTER_ARN
export AUTH0_CLIENT_ID="..."
export AUTH0_CLIENT_SECRET="..."

npm run deploy
```

Result:
- Uses your existing VPC
- Creates new MSK cluster in your VPC

### Use Existing MSK + Create New VPC

```bash
export EXISTING_MSK_CLUSTER_ARN="arn:aws:kafka:..."
# Don't set EXISTING_VPC_ID
export AUTH0_CLIENT_ID="..."
export AUTH0_CLIENT_SECRET="..."

npm run deploy
```

Result:
- Creates new VPC
- Uses your existing MSK cluster
- ⚠️ **Note**: You'll need to configure VPC peering or transit gateway if MSK is in a different VPC

---

## Troubleshooting

### Issue: Lambda Cannot Connect to MSK

**Error**: Lambda timeout or connection refused when connecting to MSK

**Solution**: Verify VPC default security group allows internal communication:

```bash
# 1. Get VPC default security group
VPC_ID="vpc-xxxxxxxx"  # Your VPC ID
DEFAULT_SG=$(aws ec2 describe-security-groups \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=default" \
  --query "SecurityGroups[0].GroupId" --output text)

echo "VPC Default Security Group: $DEFAULT_SG"

# 2. Verify it allows internal communication (should have self-referencing rule)
aws ec2 describe-security-groups --group-ids "$DEFAULT_SG" \
  --query "SecurityGroups[0].IpPermissions"

# 3. If no self-referencing rule exists, add one
aws ec2 authorize-security-group-ingress \
  --group-id "$DEFAULT_SG" \
  --source-group "$DEFAULT_SG" \
  --protocol -1 \
  --region us-east-1

# 4. Verify Lambda and MSK are in the same VPC
aws lambda get-function-configuration \
  --function-name SubmissionWatcherLambda \
  --query "VpcConfig.VpcId"
```

### Issue: VPC Lookup Fails

**Error**: `No VPC found matching criteria`

**Solution**: Ensure the VPC ID is correct:

```bash
aws ec2 describe-vpcs --vpc-ids vpc-xxxxxxxx --region us-east-1
```

### Issue: Lambda Cannot Connect to MSK

**Error**: Lambda timeout or connection refused

**Solution**: Check security group rules:

```bash
# 1. Get Lambda security group
aws lambda get-function-configuration \
  --function-name SubmissionWatcherLambda \
  --region us-east-1 \
  --query "VpcConfig.SecurityGroupIds"

# 2. Verify MSK security group allows Lambda SG
aws ec2 describe-security-groups \
  --group-ids sg-msk-xxxxx \
  --region us-east-1

# 3. Add rule if missing
aws ec2 authorize-security-group-ingress \
  --group-id sg-msk-xxxxx \
  --source-group sg-lambda-xxxxx \
  --protocol tcp \
  --port 9094 \
  --region us-east-1
```

### Issue: Subnets Not Found in VPC

**Error**: `No private subnets found in VPC`

**Solution**: The VPC must have subnets tagged properly:

```bash
# Check subnets
aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=vpc-xxxxxxxx" \
  --region us-east-1

# Ensure subnets are tagged with:
# - Public subnets: Tag "aws-cdk:subnet-type" = "Public"
# - Private subnets: Tag "aws-cdk:subnet-type" = "Private"
```

If not tagged, CDK's `Vpc.fromLookup()` may not find them correctly.

---

## Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EXISTING_MSK_CLUSTER_ARN` | No | - | ARN of existing MSK cluster. If set, no new MSK created. |
| `EXISTING_VPC_ID` | No | - | VPC ID of existing VPC. If set, no new VPC created. |
| `EXISTING_PRIVATE_SUBNET_IDS` | No | - | Comma-separated private subnet IDs. If not set, auto-discovered from VPC. |
| `EXISTING_SECURITY_GROUP_IDS` | No | - | Comma-separated security group IDs for Lambda/ECS. |
| `AUTH0_CLIENT_ID` | **Yes** | - | Auth0 M2M client ID |
| `AUTH0_CLIENT_SECRET` | **Yes** | - | Auth0 M2M client secret |
| `MSK_CLUSTER_NAME` | No | `match-scorer` | Name for new MSK cluster (ignored if using existing) |
| `ECS_CLUSTER_NAME` | No | `match-scorer-ecs-cluster` | ECS cluster name |
| `LOG_GROUP_NAME` | No | `/ecs/match-scorer` | CloudWatch log group name |
| `TASK_TIMEOUT_SECONDS` | No | `60` | ECS task timeout |
| `MAX_RETRIES` | No | `3` | Max retries for failed tasks |
| `SUBMISSION_API_URL` | No | `https://api.topcoder-dev.com/v6` | Topcoder API URL |
| `REVIEW_SCORECARD_ID` | No | `30001852` | Review scorecard ID |
| `REVIEW_TYPE_NAME` | No | `MMScorer` | Review type name |
| `LOG_LEVEL` | No | `debug` | Log level (debug, info, warn, error) |

---

## Cost Comparison

### Using Existing MSK & VPC

| Service | Monthly Cost |
|---------|-------------|
| MSK Cluster | **$0** (existing) |
| NAT Gateway | **$0** (existing) |
| ECS Fargate | ~$12 |
| Lambda | <$1 |
| CloudWatch Logs | ~$2.50 |
| ECR Storage | ~$1 |
| Data Transfer | ~$5-20 |
| **Total** | **~$20-35/month** |

### Creating New MSK & VPC

| Service | Monthly Cost |
|---------|-------------|
| MSK Cluster | ~$300 |
| NAT Gateway | ~$64 |
| ECS Fargate | ~$12 |
| Lambda | <$1 |
| CloudWatch Logs | ~$2.50 |
| ECR Storage | ~$1 |
| Data Transfer | ~$5-20 |
| **Total** | **~$385-405/month** |

---

## Validation

After deployment, verify the configuration:

```bash
# Check which mode was used
aws cloudformation describe-stacks \
  --stack-name MatchScorerStack \
  --region us-east-1 \
  --query "Stacks[0].Outputs"

# Expected outputs:
# - VpcId: Shows VPC ID (existing or created)
# - MskClusterArnOutput: Shows MSK ARN (existing or created)

# Verify Lambda can access MSK
aws lambda get-function-configuration \
  --function-name SubmissionWatcherLambda \
  --region us-east-1 \
  --query "VpcConfig"

# Check Event Source Mapping
aws lambda list-event-source-mappings \
  --function-name SubmissionWatcherLambda \
  --region us-east-1
```

---

## Best Practices

1. **Use Existing Infrastructure in Production**
   - Reduces costs by ~90%
   - Faster deployments (8-12 min vs 25-35 min)
   - Avoids creating duplicate resources

2. **Create New Infrastructure for Dev/Test**
   - Isolated environment
   - Can be easily torn down
   - No dependency on shared resources

3. **Security Group Management**
   - Always verify security group rules
   - Use least privilege (specific ports only)
   - Document any manual SG changes

4. **VPC Requirements**
   - Ensure proper subnet tagging
   - Verify NAT Gateway or VPC endpoints exist
   - Check route tables for internet access

5. **MSK Compatibility**
   - Use Kafka 3.4.0 or compatible
   - Enable auto.create.topics.enable
   - TLS encryption required

---

**Last Updated**: 2026-01-12  
**Version**: 1.1.0
