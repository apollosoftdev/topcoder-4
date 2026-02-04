import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

interface DynamoDbConstructProps {
  tableName: string;
}

export class DynamoDbConstruct extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DynamoDbConstructProps) {
    super(scope, id);

    const { tableName } = props;

    // Challenge Queue Mapping Table
    // Schema:
    // - challengeId (PK): String - UUID of the challenge
    // - queueUrl: String - SQS queue URL
    // - queueArn: String - SQS queue ARN
    // - dlqUrl: String - Dead Letter Queue URL
    // - challengeName: String - Human-readable name
    // - active: Boolean - Whether routing is active
    // - createdAt: String - ISO timestamp
    // - updatedAt: String - ISO timestamp
    this.table = new dynamodb.Table(this, 'ChallengeQueueMappingTable', {
      tableName: tableName,
      partitionKey: {
        name: 'challengeId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For POC only
      pointInTimeRecovery: false, // Enable for production
    });
  }
}
