import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

// --- Submission Watcher Lambda (Per-Challenge, SQS-Triggered) ---

interface SubmissionWatcherLambdaProps {
  vpc: ec2.IVpc;
  vpcSecurityGroups?: ec2.ISecurityGroup[];
  challengeId: string;
  challengeName: string;
  queue: sqs.Queue;
  ecsClusterName: string;
  ecsTaskDefinitionArn: string;
  ecsSubnetIds: string[];
  ecsTaskSecurityGroupId: string;
  ecsContainerName: string;
  taskExecutionRoleArn: string;
  taskRoleArn: string;
  environmentVariables: { [key: string]: string };
  lambdaCodePath: string;
  existingLambdaRoleArn?: string;
}

export class SubmissionWatcherLambdaConstruct extends Construct {
  public readonly lambdaFunction: lambda.Function;
  public readonly lambdaRole: iam.IRole;

  constructor(scope: Construct, id: string, props: SubmissionWatcherLambdaProps) {
    super(scope, id);

    const {
      vpc,
      vpcSecurityGroups,
      challengeId,
      challengeName,
      queue,
      ecsClusterName,
      ecsTaskDefinitionArn,
      ecsSubnetIds,
      ecsTaskSecurityGroupId,
      ecsContainerName,
      taskExecutionRoleArn,
      taskRoleArn,
      environmentVariables,
      lambdaCodePath,
      existingLambdaRoleArn,
    } = props;

    const sanitizedName = challengeName.replace(/[^a-zA-Z0-9-]/g, '-');

    // --- Lambda Execution Role ---
    if (existingLambdaRoleArn) {
      console.log(`Using existing Lambda role for Submission Watcher ${challengeName}: ${existingLambdaRoleArn}`);
      this.lambdaRole = iam.Role.fromRoleArn(this, 'SubmissionWatcherLambdaRole', existingLambdaRoleArn, {
        mutable: false,
      });
    } else {
      console.log(`Creating new Lambda role for Submission Watcher ${challengeName}`);
      const newRole = new iam.Role(this, 'SubmissionWatcherLambdaRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
        ],
      });

      // ECS permissions
      newRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:TagResource'],
          resources: ['*'],
        })
      );

      // SSM permissions
      newRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ssm:GetParameter', 'ssm:GetParameters'],
          resources: ['arn:aws:ssm:*:*:parameter/scorer/*'],
        })
      );

      // IAM PassRole for ECS
      newRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['iam:PassRole'],
          resources: [taskExecutionRoleArn, taskRoleArn],
        })
      );

      // SQS permissions
      newRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:GetQueueAttributes',
          ],
          resources: [queue.queueArn],
        })
      );

      this.lambdaRole = newRole;
    }

    // Determine security groups
    let lambdaSecurityGroups: ec2.ISecurityGroup[] | undefined;
    if (vpcSecurityGroups && vpcSecurityGroups.length > 0) {
      lambdaSecurityGroups = vpcSecurityGroups;
    }

    // Skip Docker bundling in CI/CD
    const skipDockerBundling = process.env.CI === 'true' || process.env.SIMPLE_BUNDLING === 'true';

    if (skipDockerBundling) {
      this.lambdaFunction = new lambda.Function(this, 'SubmissionWatcherLambda', {
        functionName: `SubmissionWatcher-${sanitizedName}`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(lambdaCodePath),
        timeout: cdk.Duration.seconds(120),
        memorySize: 256,
        role: this.lambdaRole,
        environment: {
          ...environmentVariables,
          CHALLENGE_ID: challengeId,
          ECS_CLUSTER: ecsClusterName,
          ECS_TASK_DEFINITION: ecsTaskDefinitionArn,
          ECS_SUBNETS: ecsSubnetIds.join(','),
          ECS_SECURITY_GROUPS: ecsTaskSecurityGroupId,
          ECS_CONTAINER_NAME: ecsContainerName,
        },
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: lambdaSecurityGroups,
      });
    } else {
      this.lambdaFunction = new lambda.Function(this, 'SubmissionWatcherLambda', {
        functionName: `SubmissionWatcher-${sanitizedName}`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(lambdaCodePath, {
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            command: ['bash', '-c', 'npm install && cp -R . /asset-output'],
            user: 'root',
          },
        }),
        timeout: cdk.Duration.seconds(120),
        memorySize: 256,
        role: this.lambdaRole,
        environment: {
          ...environmentVariables,
          CHALLENGE_ID: challengeId,
          ECS_CLUSTER: ecsClusterName,
          ECS_TASK_DEFINITION: ecsTaskDefinitionArn,
          ECS_SUBNETS: ecsSubnetIds.join(','),
          ECS_SECURITY_GROUPS: ecsTaskSecurityGroupId,
          ECS_CONTAINER_NAME: ecsContainerName,
        },
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: lambdaSecurityGroups,
      });
    }

    // SQS Event Source
    this.lambdaFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(queue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      })
    );
  }
}

// --- Router Lambda Construct ---

interface RouterLambdaProps {
  vpc: ec2.IVpc;
  vpcSecurityGroups?: ec2.ISecurityGroup[];
  mskSecurityGroup?: ec2.ISecurityGroup;
  mskClusterArn: string;
  snsTopic: sns.Topic;
  dynamoDbTable: dynamodb.Table;
  lambdaCodePath: string;
  existingLambdaRoleArn?: string;
}

export class RouterLambdaConstruct extends Construct {
  public readonly lambdaFunction: lambda.Function;
  public readonly lambdaRole: iam.IRole;

  constructor(scope: Construct, id: string, props: RouterLambdaProps) {
    super(scope, id);

    const {
      vpc,
      vpcSecurityGroups,
      mskSecurityGroup,
      mskClusterArn,
      snsTopic,
      dynamoDbTable,
      lambdaCodePath,
      existingLambdaRoleArn,
    } = props;

    // --- Lambda Execution Role ---
    if (existingLambdaRoleArn) {
      console.log(`Using existing Lambda role for Router: ${existingLambdaRoleArn}`);
      this.lambdaRole = iam.Role.fromRoleArn(this, 'RouterLambdaRole', existingLambdaRoleArn, {
        mutable: false,
      });
    } else {
      console.log('Creating new Lambda role for Router');
      const newRole = new iam.Role(this, 'RouterLambdaRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
        ],
      });

      // SNS publish permissions
      newRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['sns:Publish'],
          resources: [snsTopic.topicArn],
        })
      );

      // DynamoDB read permissions
      newRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['dynamodb:GetItem'],
          resources: [dynamoDbTable.tableArn],
        })
      );

      // MSK permissions
      newRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'kafka:DescribeCluster',
            'kafka:GetBootstrapBrokers',
            'kafka:ListClusters',
            'ec2:DescribeNetworkInterfaces',
            'ec2:CreateNetworkInterface',
            'ec2:DeleteNetworkInterface',
            'ec2:DescribeSecurityGroups',
            'ec2:DescribeSubnets',
            'ec2:DescribeVpcs',
          ],
          resources: ['*'],
        })
      );

      this.lambdaRole = newRole;
    }

    // Determine security groups
    let lambdaSecurityGroups: ec2.ISecurityGroup[] | undefined;
    if (mskSecurityGroup) {
      lambdaSecurityGroups = [mskSecurityGroup];
    } else if (vpcSecurityGroups && vpcSecurityGroups.length > 0) {
      lambdaSecurityGroups = vpcSecurityGroups;
    }

    // Skip Docker bundling in CI/CD
    const skipDockerBundling = process.env.CI === 'true' || process.env.SIMPLE_BUNDLING === 'true';

    if (skipDockerBundling) {
      this.lambdaFunction = new lambda.Function(this, 'RouterLambda', {
        functionName: 'RouterLambda',
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(lambdaCodePath),
        timeout: cdk.Duration.seconds(60),
        memorySize: 128,
        role: this.lambdaRole,
        environment: {
          SNS_TOPIC_ARN: snsTopic.topicArn,
          CHALLENGE_MAPPING_TABLE: dynamoDbTable.tableName,
        },
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: lambdaSecurityGroups,
      });
    } else {
      this.lambdaFunction = new lambda.Function(this, 'RouterLambda', {
        functionName: 'RouterLambda',
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(lambdaCodePath, {
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            command: ['bash', '-c', 'npm install && cp -R . /asset-output'],
            user: 'root',
          },
        }),
        timeout: cdk.Duration.seconds(60),
        memorySize: 128,
        role: this.lambdaRole,
        environment: {
          SNS_TOPIC_ARN: snsTopic.topicArn,
          CHALLENGE_MAPPING_TABLE: dynamoDbTable.tableName,
        },
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: lambdaSecurityGroups,
      });
    }

    // MSK Event Source Mapping
    new lambda.CfnEventSourceMapping(this, 'RouterKafkaEventSourceMapping', {
      functionName: this.lambdaFunction.functionName,
      eventSourceArn: mskClusterArn,
      topics: ['submission.notification.create'],
      batchSize: 100,
      startingPosition: 'TRIM_HORIZON',
      maximumBatchingWindowInSeconds: 1,
    });
  }
}

// --- Completion Lambda Construct ---

interface CompletionLambdaProps {
  lambdaCodePath: string;
  dynamoDbTable: dynamodb.Table;
  sqsQueueArns: string[];
  maxRetries: string;
  existingLambdaRoleArn?: string;
}

export class CompletionLambdaConstruct extends Construct {
  public readonly lambdaFunction: lambda.Function;
  public readonly lambdaRole: iam.IRole;

  constructor(scope: Construct, id: string, props: CompletionLambdaProps) {
    super(scope, id);

    const { lambdaCodePath, dynamoDbTable, sqsQueueArns, maxRetries, existingLambdaRoleArn } = props;

    // --- Lambda Execution Role ---
    if (existingLambdaRoleArn) {
      console.log(`Using existing Lambda role for Completion Lambda: ${existingLambdaRoleArn}`);
      this.lambdaRole = iam.Role.fromRoleArn(this, 'CompletionLambdaRole', existingLambdaRoleArn, {
        mutable: false,
      });
    } else {
      console.log('Creating new Lambda role for Completion Lambda');
      const newRole = new iam.Role(this, 'CompletionLambdaRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      });

      // DynamoDB read permissions (for getting queue URL)
      newRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['dynamodb:GetItem'],
          resources: [dynamoDbTable.tableArn],
        })
      );

      // SQS send message permissions (for retry)
      if (sqsQueueArns.length > 0) {
        newRole.addToPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sqs:SendMessage'],
            resources: sqsQueueArns,
          })
        );
      }

      this.lambdaRole = newRole;
    }

    // Skip Docker bundling in CI/CD
    const skipDockerBundling = process.env.CI === 'true' || process.env.SIMPLE_BUNDLING === 'true';

    if (skipDockerBundling) {
      this.lambdaFunction = new lambda.Function(this, 'CompletionLambda', {
        functionName: 'CompletionLambda',
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(lambdaCodePath),
        timeout: cdk.Duration.seconds(30),
        memorySize: 128,
        role: this.lambdaRole,
        environment: {
          CHALLENGE_MAPPING_TABLE: dynamoDbTable.tableName,
          MAX_RETRIES: maxRetries,
        },
      });
    } else {
      this.lambdaFunction = new lambda.Function(this, 'CompletionLambda', {
        functionName: 'CompletionLambda',
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(lambdaCodePath, {
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            command: ['bash', '-c', 'npm install && cp -R . /asset-output'],
            user: 'root',
          },
        }),
        timeout: cdk.Duration.seconds(30),
        memorySize: 128,
        role: this.lambdaRole,
        environment: {
          CHALLENGE_MAPPING_TABLE: dynamoDbTable.tableName,
          MAX_RETRIES: maxRetries,
        },
      });
    }
  }
}
