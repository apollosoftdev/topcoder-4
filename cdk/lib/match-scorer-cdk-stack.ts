import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';
import * as ssm from 'aws-cdk-lib/aws-ssm';

// Import the constructs
import { VpcConstruct } from './vpc-construct';
import { MskConstruct } from './msk-construct';
import { EcsConstruct } from './ecs-construct';
import { DynamoDbConstruct } from './dynamodb-construct';
import { SnsSqsConstruct } from './sns-sqs-construct';
import { EventBridgeConstruct } from './eventbridge-construct';
import {
  SubmissionWatcherLambdaConstruct,
  RouterLambdaConstruct,
  ChallengeProcessorLambdaConstruct,
  CompletionLambdaConstruct,
} from './lambda-constructs';

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

    // --- DynamoDB Construct (Fan-out Architecture) ---
    const dynamoDbConstruct = new DynamoDbConstruct(this, 'DynamoDbConstruct', {
      tableName: config.challengeMappingTableName,
    });

    // --- SNS/SQS Construct (Fan-out Architecture) ---
    const snsSqsConstruct = new SnsSqsConstruct(this, 'SnsSqsConstruct', {
      snsTopicName: config.snsTopicName,
      challenges: config.challenges,
      visibilityTimeoutSeconds: parseInt(config.sqsVisibilityTimeoutSeconds),
      messageRetentionDays: parseInt(config.sqsMessageRetentionDays),
      maxReceiveCount: parseInt(config.sqsMaxReceiveCount),
      dlqRetentionDays: parseInt(config.dlqRetentionDays),
      dynamoDbTable: dynamoDbConstruct.table,
    });

    // --- Completion Lambda (must be created before EventBridge) ---
    const completionLambda = new CompletionLambdaConstruct(this, 'CompletionLambda', {
      lambdaCodePath: path.join(__dirname, '..', '..', 'completion-lambda'),
      existingLambdaRoleArn: config.existingLambdaRoleArn,
    });

    // --- EventBridge Construct (Fan-out Architecture) ---
    const eventBridgeConstruct = new EventBridgeConstruct(this, 'EventBridgeConstruct', {
      ruleName: config.ecsTaskStateRuleName,
      ecsClusterArn: ecsConstruct.cluster.clusterArn,
      completionLambda: completionLambda.lambdaFunction,
    });

    // --- Router Lambda (Fan-out Architecture) ---
    const routerLambda = new RouterLambdaConstruct(this, 'RouterLambda', {
      vpc: vpcConstruct.vpc,
      vpcSecurityGroups: vpcConstruct.securityGroups,
      mskSecurityGroup: mskConstruct.mskSecurityGroup,
      mskClusterArn: mskConstruct.mskClusterArn,
      snsTopic: snsSqsConstruct.topic,
      dynamoDbTable: dynamoDbConstruct.table,
      lambdaCodePath: path.join(__dirname, '..', '..', 'router-lambda'),
      existingLambdaRoleArn: config.existingLambdaRoleArn,
    });

    // --- Challenge Processor Lambdas (one per challenge) ---
    const challengeProcessorLambdas: ChallengeProcessorLambdaConstruct[] = [];
    for (const challenge of config.challenges) {
      const queueMapping = snsSqsConstruct.challengeQueues.get(challenge.challengeId);
      if (!queueMapping) {
        console.warn(`No queue mapping found for challenge ${challenge.challengeId}`);
        continue;
      }

      const processorLambda = new ChallengeProcessorLambdaConstruct(
        this,
        `ChallengeProcessor-${challenge.challengeName}`,
        {
          vpc: vpcConstruct.vpc,
          vpcSecurityGroups: vpcConstruct.securityGroups,
          challengeId: challenge.challengeId,
          challengeName: challenge.challengeName,
          queue: queueMapping.queue,
          ecsClusterName: ecsConstruct.cluster.clusterName,
          ecsTaskDefinitionArn: ecsConstruct.taskDefinition.taskDefinitionArn,
          ecsSubnetIds: vpcConstruct.privateSubnets.map(subnet => subnet.subnetId),
          ecsTaskSecurityGroupId: ecsConstruct.taskSecurityGroup.securityGroupId,
          ecsContainerName: ecsConstruct.container.containerName,
          taskExecutionRoleArn: config.ecsTaskExecutionRoleArn,
          taskRoleArn: config.ecsTaskRoleArn,
          environmentVariables: {
            AUTH0_URL: config.auth0Url,
            AUTH0_AUDIENCE: config.auth0Audience,
            AUTH0_CLIENT_ID: config.auth0ClientId,
            AUTH0_CLIENT_SECRET: config.auth0ClientSecret,
            AUTH0_PROXY_URL: config.auth0ProxyUrl,
          },
          lambdaCodePath: path.join(__dirname, '..', '..', 'challenge-processor-lambda'),
          existingLambdaRoleArn: config.existingLambdaRoleArn,
        }
      );
      challengeProcessorLambdas.push(processorLambda);
    }

    // --- Legacy Submission Watcher Lambda (kept for reference/fallback) ---
    const submissionWatcherLambda = new SubmissionWatcherLambdaConstruct(this, 'SubmissionWatcherLambda', {
        vpc: vpcConstruct.vpc,
        vpcSecurityGroups: vpcConstruct.securityGroups,
        mskSecurityGroup: mskConstruct.mskSecurityGroup,
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
        existingLambdaRoleArn: config.existingLambdaRoleArn
    });

    // --- Outputs (Base Infrastructure) ---
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
      description: 'ARN of the Submission Watcher Lambda function (legacy)',
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

    // --- Outputs (Fan-out Architecture) ---
    new cdk.CfnOutput(this, 'DynamoDbTableName', {
      value: dynamoDbConstruct.table.tableName,
      description: 'DynamoDB table name for challenge-queue mapping',
    });

    new cdk.CfnOutput(this, 'SnsTopicArn', {
      value: snsSqsConstruct.topic.topicArn,
      description: 'SNS topic ARN for submission fan-out',
    });

    new cdk.CfnOutput(this, 'RouterLambdaFunctionArn', {
      value: routerLambda.lambdaFunction.functionArn,
      description: 'ARN of the Router Lambda function',
    });

    new cdk.CfnOutput(this, 'CompletionLambdaFunctionArn', {
      value: completionLambda.lambdaFunction.functionArn,
      description: 'ARN of the Completion Lambda function',
    });

    new cdk.CfnOutput(this, 'EventBridgeRuleName', {
      value: eventBridgeConstruct.rule.ruleName,
      description: 'EventBridge rule name for ECS task state changes',
    });

    // Output challenge processor Lambda ARNs
    challengeProcessorLambdas.forEach((processor, index) => {
      new cdk.CfnOutput(this, `ChallengeProcessorLambdaArn${index}`, {
        value: processor.lambdaFunction.functionArn,
        description: `ARN of Challenge Processor Lambda for ${config.challenges[index]?.challengeName}`,
      });
    });

    // Output SQS queue URLs for each challenge
    for (const [_challengeId, mapping] of snsSqsConstruct.challengeQueues) {
      const sanitizedName = mapping.challengeName.replace(/[^a-zA-Z0-9-]/g, '-');
      new cdk.CfnOutput(this, `SqsQueueUrl-${sanitizedName}`, {
        value: mapping.queue.queueUrl,
        description: `SQS queue URL for challenge ${mapping.challengeName}`,
      });
    }

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

    // --- DynamoDB Seeding Output ---
    // Output CLI commands for seeding the DynamoDB table
    const seedCommands = config.challenges.map(challenge => {
      const queueMapping = snsSqsConstruct.challengeQueues.get(challenge.challengeId);
      if (!queueMapping) return '';
      return `aws dynamodb put-item --table-name ${config.challengeMappingTableName} --item '{"challengeId":{"S":"${challenge.challengeId}"},"queueUrl":{"S":"${queueMapping.queue.queueUrl}"},"queueArn":{"S":"${queueMapping.queue.queueArn}"},"dlqUrl":{"S":"${queueMapping.dlq.queueUrl}"},"challengeName":{"S":"${challenge.challengeName}"},"active":{"BOOL":true},"createdAt":{"S":"${new Date().toISOString()}"},"updatedAt":{"S":"${new Date().toISOString()}"}}'`;
    }).filter(cmd => cmd.length > 0);

    new cdk.CfnOutput(this, 'DynamoDBSeedCommand', {
      value: seedCommands.join(' && '),
      description: 'AWS CLI commands to seed the DynamoDB challenge-queue mapping table',
    });
  }
}
