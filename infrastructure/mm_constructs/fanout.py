"""SNS/SQS fan-out construct for routing submissions to challenge-specific queues."""
from aws_cdk import (
    aws_sns as sns,
    aws_sqs as sqs,
    aws_sns_subscriptions as subscriptions,
    Duration
)
from constructs import Construct


class FanoutConstruct(Construct):
    """Creates SNS topic and per-challenge SQS queues with filter policies."""

    def __init__(self, scope: Construct, id: str, challenge_ids: list[str]):
        """Initialize the fan-out construct.

        Args:
            scope: CDK scope.
            id: Construct ID.
            challenge_ids: List of challenge IDs to create queues for.
        """
        super().__init__(scope, id)

        # SNS Topic
        self.topic = sns.Topic(self, 'SubmissionTopic',
            topic_name='mm-submission-topic'
        )

        self.queues = {}
        self.dlqs = {}

        # Per-challenge SQS queues with DLQ
        for challenge_id in challenge_ids:
            dlq = sqs.Queue(self, f'{challenge_id}-dlq',
                queue_name=f'mm-{challenge_id}-dlq',
                retention_period=Duration.days(14)
            )

            queue = sqs.Queue(self, f'{challenge_id}-queue',
                queue_name=f'mm-{challenge_id}-queue',
                visibility_timeout=Duration.seconds(300),
                dead_letter_queue=sqs.DeadLetterQueue(
                    queue=dlq,
                    max_receive_count=3
                )
            )

            # SNS subscription with filter policy
            self.topic.add_subscription(
                subscriptions.SqsSubscription(queue,
                    filter_policy={
                        'challengeId': sns.SubscriptionFilter.string_filter(
                            allowlist=[challenge_id]
                        )
                    }
                )
            )

            self.queues[challenge_id] = queue
            self.dlqs[challenge_id] = dlq
