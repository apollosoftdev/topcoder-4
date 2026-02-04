#!/bin/bash
# Manual Bootstrap Script for CDK
# This script creates the minimum required resources without using cdk bootstrap

set -e

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)
QUALIFIER="hnb659fds"

echo "Creating CDK bootstrap resources manually..."
echo "Account: $ACCOUNT_ID"
echo "Region: $REGION"

# 1. Create S3 Bucket for Assets
BUCKET_NAME="cdk-${QUALIFIER}-assets-${ACCOUNT_ID}-${REGION}"
echo "Creating S3 bucket: $BUCKET_NAME"

aws s3api create-bucket \
  --bucket "$BUCKET_NAME" \
  --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION" 2>/dev/null || echo "Bucket already exists"

aws s3api put-bucket-versioning \
  --bucket "$BUCKET_NAME" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "$BUCKET_NAME" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# 2. Create ECR Repository for Container Images
REPO_NAME="cdk-${QUALIFIER}-container-assets-${ACCOUNT_ID}-${REGION}"
echo "Creating ECR repository: $REPO_NAME"

aws ecr create-repository \
  --repository-name "$REPO_NAME" \
  --image-tag-mutability IMMUTABLE \
  --region "$REGION" 2>/dev/null || echo "Repository already exists"

# 3. Create IAM Role for CloudFormation Execution
ROLE_NAME="cdk-${QUALIFIER}-cfn-exec-role-${ACCOUNT_ID}-${REGION}"
echo "Creating IAM role: $ROLE_NAME"

cat > /tmp/trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Service": "cloudformation.amazonaws.com"
    },
    "Action": "sts:AssumeRole"
  }]
}
EOF

aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document file:///tmp/trust-policy.json \
  --description "CloudFormation execution role for CDK" 2>/dev/null || echo "Role already exists"

# Attach necessary policies (adjust based on your needs)
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/PowerUserAccess" 2>/dev/null || true

# 4. Create IAM Role for Deployment
DEPLOY_ROLE_NAME="cdk-${QUALIFIER}-deploy-role-${ACCOUNT_ID}-${REGION}"
echo "Creating deployment role: $DEPLOY_ROLE_NAME"

cat > /tmp/deploy-trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "AWS": "arn:aws:iam::${ACCOUNT_ID}:root"
    },
    "Action": ["sts:AssumeRole", "sts:TagSession"]
  }]
}
EOF

aws iam create-role \
  --role-name "$DEPLOY_ROLE_NAME" \
  --assume-role-policy-document file:///tmp/deploy-trust-policy.json \
  --description "CDK deployment role" 2>/dev/null || echo "Role already exists"

# Create inline policy for deployment role
cat > /tmp/deploy-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:*",
        "s3:GetObject*",
        "s3:GetBucket*",
        "s3:List*",
        "ssm:GetParameter*"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name "$DEPLOY_ROLE_NAME" \
  --policy-name "cdk-deploy-policy" \
  --policy-document file:///tmp/deploy-policy.json

# 5. Create IAM Role for File Publishing
FILE_ROLE_NAME="cdk-${QUALIFIER}-file-publishing-role-${ACCOUNT_ID}-${REGION}"
echo "Creating file publishing role: $FILE_ROLE_NAME"

aws iam create-role \
  --role-name "$FILE_ROLE_NAME" \
  --assume-role-policy-document file:///tmp/deploy-trust-policy.json \
  --description "CDK file publishing role" 2>/dev/null || echo "Role already exists"

cat > /tmp/file-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "s3:GetObject*",
      "s3:GetBucket*",
      "s3:List*",
      "s3:DeleteObject*",
      "s3:PutObject*",
      "s3:Abort*"
    ],
    "Resource": [
      "arn:aws:s3:::${BUCKET_NAME}",
      "arn:aws:s3:::${BUCKET_NAME}/*"
    ]
  }]
}
EOF

aws iam put-role-policy \
  --role-name "$FILE_ROLE_NAME" \
  --policy-name "cdk-file-publishing-policy" \
  --policy-document file:///tmp/file-policy.json

# 6. Create IAM Role for Image Publishing
IMAGE_ROLE_NAME="cdk-${QUALIFIER}-image-publishing-role-${ACCOUNT_ID}-${REGION}"
echo "Creating image publishing role: $IMAGE_ROLE_NAME"

aws iam create-role \
  --role-name "$IMAGE_ROLE_NAME" \
  --assume-role-policy-document file:///tmp/deploy-trust-policy.json \
  --description "CDK image publishing role" 2>/dev/null || echo "Role already exists"

cat > /tmp/image-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:BatchCheckLayerAvailability",
        "ecr:DescribeRepositories",
        "ecr:DescribeImages",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": "arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/${REPO_NAME}"
    },
    {
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name "$IMAGE_ROLE_NAME" \
  --policy-name "cdk-image-publishing-policy" \
  --policy-document file:///tmp/image-policy.json

# 7. Create SSM Parameter for version
echo "Creating SSM parameter for bootstrap version"
aws ssm put-parameter \
  --name "/cdk-bootstrap/${QUALIFIER}/version" \
  --value "27" \
  --type "String" \
  --overwrite 2>/dev/null || echo "Parameter already exists"

# Cleanup
rm -f /tmp/trust-policy.json /tmp/deploy-trust-policy.json /tmp/deploy-policy.json /tmp/file-policy.json /tmp/image-policy.json

echo ""
echo "✅ Manual bootstrap completed successfully!"
echo ""
echo "Created resources:"
echo "  - S3 Bucket: $BUCKET_NAME"
echo "  - ECR Repository: $REPO_NAME"
echo "  - IAM Role (CFN Exec): $ROLE_NAME"
echo "  - IAM Role (Deploy): $DEPLOY_ROLE_NAME"
echo "  - IAM Role (File Publishing): $FILE_ROLE_NAME"
echo "  - IAM Role (Image Publishing): $IMAGE_ROLE_NAME"
echo "  - SSM Parameter: /cdk-bootstrap/${QUALIFIER}/version"
echo ""
echo "You can now run: npm run deploy"
