import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';
import * as ssm from 'aws-cdk-lib/aws-ssm';

// Import the new constructs
import { VpcConstruct } from './vpc-construct';
import { MskConstruct } from './msk-construct';
import { EcsConstruct } from './ecs-construct';
import { SubmissionWatcherLambdaConstruct } from './lambda-constructs';

// Import the configuration
import { config, devScorers } from './config';

export class MatchScorerCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Base Infrastructure ---
    // VPC: Use existing or create new
    const vpcConstruct = new VpcConstruct(this, 'VpcConstruct', {
      existingVpcId: config.existingVpcId,
      existingPrivateSubnetIds: config.existingPrivateSubnetIds,
      existingSecurityGroupIds: config.existingSecurityGroupIds,
    });
    
    const logGroup = new logs.LogGroup(this, 'MatchScorerLogGroup', {
      logGroupName: config.logGroupName,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For POC only
    });

    // Validate that required role ARNs are provided
    if (!config.ecsTaskExecutionRoleArn || !config.ecsTaskRoleArn) {
      throw new Error('ECS_TASK_EXECUTION_ROLE_ARN and ECS_TASK_ROLE_ARN environment variables must be provided');
    }

    // --- MSK Construct ---
    // MSK: Use existing or create new (uses VPC default security group)
    const mskConstruct = new MskConstruct(this, 'MskConstruct', {
      vpc: vpcConstruct.vpc,
      clusterName: config.mskClusterName,
      existingMskClusterArn: config.existingMskClusterArn,
      existingMskSecurityGroupId: config.existingMskSecurityGroupId,
      privateSubnetIds: vpcConstruct.privateSubnets.map(subnet => subnet.subnetId),
    });

    // --- ECS Construct ---
    const ecsConstruct = new EcsConstruct(this, 'EcsConstruct', {
        vpc: vpcConstruct.vpc,
        logGroup: logGroup,
        clusterName: config.ecsClusterName,
        dockerImagePath: path.join(__dirname, '..', '..', 'java-scorer'),
        containerEnvironment: {
            AWS_REGION: cdk.Stack.of(this).region,
        },
        taskExecutionRoleArn: config.ecsTaskExecutionRoleArn,
        taskRoleArn: config.ecsTaskRoleArn
    });

    // --- Lambda Constructs ---
    const submissionWatcherLambda = new SubmissionWatcherLambdaConstruct(this, 'SubmissionWatcherLambda', {
        vpc: vpcConstruct.vpc,
        vpcSecurityGroups: vpcConstruct.securityGroups, // Pass VPC security groups
        mskSecurityGroup: mskConstruct.mskSecurityGroup, // Pass MSK security group if available
        mskClusterArn: mskConstruct.mskClusterArn,
        ecsClusterName: ecsConstruct.cluster.clusterName,
        ecsTaskDefinitionArn: ecsConstruct.taskDefinition.taskDefinitionArn,
        ecsSubnetIds: vpcConstruct.privateSubnets.map(subnet => subnet.subnetId),
        ecsTaskSecurityGroupId: ecsConstruct.taskSecurityGroup.securityGroupId,
        ecsContainerName: ecsConstruct.container.containerName,
        taskExecutionRoleArn: config.ecsTaskExecutionRoleArn,
        taskRoleArn: config.ecsTaskRoleArn,
        environmentVariables: {
            TASK_TIMEOUT_SECONDS: config.taskTimeoutSeconds,
            MAX_RETRIES: config.maxRetries,
            AUTH0_URL: config.auth0Url,
            AUTH0_AUDIENCE: config.auth0Audience,
            AUTH0_CLIENT_ID: config.auth0ClientId,
            AUTH0_CLIENT_SECRET: config.auth0ClientSecret,
            AUTH0_PROXY_URL: config.auth0ProxyUrl,
        },
        lambdaCodePath: path.join(__dirname, '..', '..', 'submission-watcher-lambda'),
        existingLambdaRoleArn: config.existingLambdaRoleArn // Pass existing role ARN if configured
    });

    // --- Outputs (Referencing construct properties) ---
    new cdk.CfnOutput(this, 'EcsClusterArn', {
      value: ecsConstruct.cluster.clusterArn,
      description: 'ARN of the ECS cluster',
    });

    new cdk.CfnOutput(this, 'EcsTaskDefinitionArn', {
      value: ecsConstruct.taskDefinition.taskDefinitionArn,
      description: 'ARN of the ECS task definition',
    });

    new cdk.CfnOutput(this, 'WatcherLambdaFunctionArn', {
      value: submissionWatcherLambda.lambdaFunction.functionArn,
      description: 'ARN of the Submission Watcher Lambda function',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: ecsConstruct.dockerImage.repository.repositoryUri,
      description: 'URI of the ECR repository',
    });

    new cdk.CfnOutput(this, 'MskClusterArnOutput', {
      value: mskConstruct.mskClusterArn,
      description: 'ARN of the MSK cluster',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpcConstruct.vpc.vpcId,
      description: 'VPC ID (existing or created)',
    });

    // --- Parameter Store Setup for Dev Challenge ---
    // Challenge config
    new ssm.CfnParameter(this, 'DevChallengeConfig', {
      name: `/scorer/challenges/${config.devChallengeId}/config`,
      type: 'String',
      value: JSON.stringify({
        name: 'Marathon Match 160',
        active: true,
        scorers: devScorers.map(scorer => scorer.name),
        submissionApiUrl: config.submissionApiUrl,
        reviewScorecardId: config.reviewScorecardId,
        reviewTypeName: config.reviewTypeName
      }),
    });

    // Scorer configs
    devScorers.forEach((scorer) => {
      new ssm.CfnParameter(this, `DevScorerConfig${scorer.name}`, {
        name: `/scorer/challenges/${config.devChallengeId}/scorers/${scorer.name}/config`,
        type: 'String',
        value: JSON.stringify({
          name: scorer.name,
          testerClass: scorer.testerClass,
          timeLimit: scorer.timeLimit,
          timeout: scorer.timeout,
          compileTimeout: scorer.compileTimeout,
          startSeed: scorer.startSeed,
          numberOfTests: scorer.numberOfTests,
          phases: scorer.phases
        }),
      });
    });
  }
} 