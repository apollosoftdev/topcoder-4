import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface ChallengeConfig {
  challengeId: string;
  challengeName: string;
}

export interface ChallengeQueueMapping {
  challengeId: string;
  challengeName: string;
  queue: sqs.Queue;
  dlq: sqs.Queue;
}

interface SnsSqsConstructProps {
  snsTopicName: string;
  challenges: ChallengeConfig[];
  visibilityTimeoutSeconds: number;
  messageRetentionDays: number;
  maxReceiveCount: number;
  dlqRetentionDays: number;
  dynamoDbTable: dynamodb.Table;
}

export class SnsSqsConstruct extends Construct {
  public readonly topic: sns.Topic;
  public readonly challengeQueues: Map<string, ChallengeQueueMapping>;

  constructor(scope: Construct, id: string, props: SnsSqsConstructProps) {
    super(scope, id);

    const {
      snsTopicName,
      challenges,
      visibilityTimeoutSeconds,
      messageRetentionDays,
      maxReceiveCount,
      dlqRetentionDays,
      dynamoDbTable,
    } = props;

    // Create SNS Topic for fan-out
    this.topic = new sns.Topic(this, 'SubmissionFanoutTopic', {
      topicName: snsTopicName,
      displayName: 'Submission Fan-out Topic',
    });

    // Initialize challenge queues map
    this.challengeQueues = new Map<string, ChallengeQueueMapping>();

    // Create SQS queues for each challenge
    for (const challenge of challenges) {
      const sanitizedName = challenge.challengeName.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();

      // Create Dead Letter Queue
      const dlq = new sqs.Queue(this, `DLQ-${sanitizedName}`, {
        queueName: `challenge-${sanitizedName}-dlq`,
        retentionPeriod: cdk.Duration.days(dlqRetentionDays),
      });

      // Create Main Queue with DLQ
      const queue = new sqs.Queue(this, `Queue-${sanitizedName}`, {
        queueName: `challenge-${sanitizedName}-queue`,
        visibilityTimeout: cdk.Duration.seconds(visibilityTimeoutSeconds),
        retentionPeriod: cdk.Duration.days(messageRetentionDays),
        deadLetterQueue: {
          queue: dlq,
          maxReceiveCount: maxReceiveCount,
        },
      });

      // Subscribe queue to SNS topic with filter policy
      this.topic.addSubscription(
        new subscriptions.SqsSubscription(queue, {
          filterPolicy: {
            challengeId: sns.SubscriptionFilter.stringFilter({
              allowlist: [challenge.challengeId],
            }),
          },
          rawMessageDelivery: true, // Send raw message without SNS envelope
        })
      );

      // Store queue mapping
      this.challengeQueues.set(challenge.challengeId, {
        challengeId: challenge.challengeId,
        challengeName: challenge.challengeName,
        queue,
        dlq,
      });

      // Create DynamoDB item for queue mapping using custom resource
      new cdk.CustomResource(this, `DynamoDBItem-${sanitizedName}`, {
        serviceToken: new cdk.CfnResource(this, `DDBProvider-${sanitizedName}`, {
          type: 'AWS::CloudFormation::WaitConditionHandle',
        }).ref,
        // Note: In production, use a Lambda-backed custom resource to populate DynamoDB
        // For now, we'll use stack outputs and manual seeding
      });
    }

    // Output the DynamoDB seeding commands
    new cdk.CfnOutput(this, 'DynamoDBSeedingInfo', {
      value: `Use AWS CLI to seed ${dynamoDbTable.tableName} with queue mappings`,
      description: 'DynamoDB table seeding instructions',
    });
  }
}
