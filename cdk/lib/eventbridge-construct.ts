import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

interface EventBridgeConstructProps {
  ruleName: string;
  ecsClusterArn: string;
  completionLambda: lambda.Function;
}

export class EventBridgeConstruct extends Construct {
  public readonly rule: events.Rule;

  constructor(scope: Construct, id: string, props: EventBridgeConstructProps) {
    super(scope, id);

    const { ruleName, ecsClusterArn, completionLambda } = props;

    // Create EventBridge rule for ECS Task State Changes
    this.rule = new events.Rule(this, 'EcsTaskStateChangeRule', {
      ruleName: ruleName,
      description: 'Triggers completion Lambda when ECS tasks stop',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [ecsClusterArn],
          lastStatus: ['STOPPED'],
        },
      },
    });

    // Add completion Lambda as target with retries
    this.rule.addTarget(
      new targets.LambdaFunction(completionLambda, {
        retryAttempts: 2,
      })
    );
  }
}
