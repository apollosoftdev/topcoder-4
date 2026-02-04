import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

// --- Submission Watcher Lambda ---

interface SubmissionWatcherLambdaProps {
  vpc: ec2.IVpc;
  vpcSecurityGroups?: ec2.ISecurityGroup[]; // Security groups from VPC construct
  mskSecurityGroup?: ec2.ISecurityGroup; // Security group from MSK construct (if available)
  mskClusterArn: string; // Use ARN directly
  ecsClusterName: string;
  ecsTaskDefinitionArn: string;
  ecsSubnetIds: string[]; // Pass subnet IDs explicitly
  ecsTaskSecurityGroupId: string;
  ecsContainerName: string;
  taskExecutionRoleArn: string;
  taskRoleArn: string;
  environmentVariables: { [key: string]: string };
  lambdaCodePath: string;
  existingLambdaRoleArn?: string; // Optional: Use existing IAM role by ARN
}

export class SubmissionWatcherLambdaConstruct extends Construct {
  public readonly lambdaFunction: lambda.Function;
  public readonly lambdaRole: iam.IRole;

  constructor(scope: Construct, id: string, props: SubmissionWatcherLambdaProps) {
    super(scope, id);

    const {
      vpc,
      vpcSecurityGroups,
      mskSecurityGroup,
      mskClusterArn,
      ecsClusterName,
      ecsTaskDefinitionArn,
      ecsSubnetIds,
      ecsTaskSecurityGroupId,
      ecsContainerName,
      taskExecutionRoleArn,
      taskRoleArn,
      environmentVariables,
      lambdaCodePath,
      existingLambdaRoleArn
    } = props;

    // --- Lambda Execution Role ---
    // Use existing role if provided, otherwise create new one
    if (existingLambdaRoleArn) {
      console.log(`Using existing Lambda role: ${existingLambdaRoleArn}`);
      this.lambdaRole = iam.Role.fromRoleArn(this, 'WatcherLambdaRole', existingLambdaRoleArn, {
        mutable: false // Cannot modify imported roles
      });
      
      // Note: Cannot add policies to imported roles
      // Ensure your existing role has the following permissions:
      // - AWSLambdaBasicExecutionRole (arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole)
      // - AWSLambdaVPCAccessExecutionRole (arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole)
      // - ECS: RunTask, DescribeTasks, StopTask, ListTasks
      // - Kafka: DescribeCluster, GetBootstrapBrokers, ListClusters
      // - EC2: VPC and network interface permissions
      // - IAM: PassRole for ECS task roles
      // - SSM: GetParameter, GetParameters for /scorer/* paths
    } else {
      console.log('Creating new Lambda role');
      const newRole = new iam.Role(this, 'WatcherLambdaRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
        ],
      });

      // Permissions to run ECS Task
      newRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:StopTask', 'ecs:ListTasks'],
          resources: ['*'], // Consider scoping this down if possible
        })
      );

      // Permissions for MSK Event Source Mapping & VPC access
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
            'ec2:DescribeVpcs'
          ],
          resources: ['*'], // Keep broad for simplicity
        })
      );

      // Permissions to pass ECS roles
      newRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['iam:PassRole'],
          resources: [taskExecutionRoleArn, taskRoleArn],
        })
      );

      // Add SSM permissions for Parameter Store config fetch
      newRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ssm:GetParameter', 'ssm:GetParameters'],
          resources: ['arn:aws:ssm:*:*:parameter/scorer/*'],
        })
      );
      
      this.lambdaRole = newRole;
    }

    // --- Lambda Function ---
    // Skip Docker bundling in CI/CD environments where volume mounting is problematic
    const skipDockerBundling = process.env.CI === 'true' || process.env.SIMPLE_BUNDLING === 'true';
    
    // Determine which security groups to use for Lambda
    let lambdaSecurityGroups: ec2.ISecurityGroup[] | undefined;
    if (mskSecurityGroup) {
      // Use MSK security group if available (for existing MSK clusters)
      lambdaSecurityGroups = [mskSecurityGroup];
      console.log('Lambda will use MSK security group for communication');
    } else if (vpcSecurityGroups && vpcSecurityGroups.length > 0) {
      // Fall back to VPC security groups
      lambdaSecurityGroups = vpcSecurityGroups;
      console.log('Lambda will use VPC security groups for communication');
    } else {
      // Let Lambda use VPC default security group
      lambdaSecurityGroups = undefined;
      console.log('Lambda will use VPC default security group for communication');
    }
    
    if (skipDockerBundling) {
      console.log('Skipping Docker bundling - using pre-installed dependencies');
      this.lambdaFunction = new lambda.Function(this, 'SubmissionWatcherLambda', {
        functionName: 'SubmissionWatcherLambda',
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(lambdaCodePath), // No bundling
        timeout: cdk.Duration.seconds(60),
        memorySize: 128,
        role: this.lambdaRole,
        environment: {
          ...environmentVariables,
          ECS_CLUSTER: ecsClusterName,
          ECS_TASK_DEFINITION: ecsTaskDefinitionArn,
          ECS_SUBNETS: ecsSubnetIds.join(','),
          ECS_SECURITY_GROUPS: ecsTaskSecurityGroupId,
          ECS_CONTAINER_NAME: ecsContainerName,
        },
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: lambdaSecurityGroups, // Use determined security groups
      });
    } else {
      // Use Docker bundling for local development
      this.lambdaFunction = new lambda.Function(this, 'SubmissionWatcherLambda', {
        functionName: 'SubmissionWatcherLambda',
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
          ...environmentVariables,
          ECS_CLUSTER: ecsClusterName,
          ECS_TASK_DEFINITION: ecsTaskDefinitionArn,
          ECS_SUBNETS: ecsSubnetIds.join(','),
          ECS_SECURITY_GROUPS: ecsTaskSecurityGroupId,
          ECS_CONTAINER_NAME: ecsContainerName,
        },
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: lambdaSecurityGroups, // Use determined security groups
      });
    }

    // --- MSK Event Source Mapping ---
    new lambda.CfnEventSourceMapping(this, 'KafkaEventSourceMapping', {
      functionName: this.lambdaFunction.functionName,
      eventSourceArn: mskClusterArn,
      topics: ['submission.notification.create'],
      batchSize: 100,
      startingPosition: 'TRIM_HORIZON',
      maximumBatchingWindowInSeconds: 1
    });

    // Lambda and MSK communicate via security groups - no additional configuration needed
    if (mskSecurityGroup) {
      console.log('Lambda assigned MSK security group for direct communication');
    } else if (vpcSecurityGroups && vpcSecurityGroups.length > 0) {
      console.log(`Lambda assigned ${vpcSecurityGroups.length} VPC security group(s) for MSK communication`);
    } else {
      console.log('Lambda will use VPC default security group for MSK communication');
    }
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

// --- Challenge Processor Lambda Construct ---

interface ChallengeProcessorLambdaProps {
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

export class ChallengeProcessorLambdaConstruct extends Construct {
  public readonly lambdaFunction: lambda.Function;
  public readonly lambdaRole: iam.IRole;

  constructor(scope: Construct, id: string, props: ChallengeProcessorLambdaProps) {
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
      console.log(`Using existing Lambda role for Challenge Processor ${challengeName}: ${existingLambdaRoleArn}`);
      this.lambdaRole = iam.Role.fromRoleArn(this, 'ChallengeProcessorLambdaRole', existingLambdaRoleArn, {
        mutable: false,
      });
    } else {
      console.log(`Creating new Lambda role for Challenge Processor ${challengeName}`);
      const newRole = new iam.Role(this, 'ChallengeProcessorLambdaRole', {
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
      this.lambdaFunction = new lambda.Function(this, 'ChallengeProcessorLambda', {
        functionName: `ChallengeProcessor-${sanitizedName}`,
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
      this.lambdaFunction = new lambda.Function(this, 'ChallengeProcessorLambda', {
        functionName: `ChallengeProcessor-${sanitizedName}`,
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

// --- Completion Lambda Construct ---

interface CompletionLambdaProps {
  lambdaCodePath: string;
  existingLambdaRoleArn?: string;
}

export class CompletionLambdaConstruct extends Construct {
  public readonly lambdaFunction: lambda.Function;
  public readonly lambdaRole: iam.IRole;

  constructor(scope: Construct, id: string, props: CompletionLambdaProps) {
    super(scope, id);

    const { lambdaCodePath, existingLambdaRoleArn } = props;

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
      });
    }
  }
} 