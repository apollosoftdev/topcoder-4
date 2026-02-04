import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
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