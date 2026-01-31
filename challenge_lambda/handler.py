"""Challenge Lambda handler for processing SQS messages and launching ECS tasks."""
import json
from config_loader import load_config
from ecs_runner import run_scorer_task

# Load config at cold start (module level)
config = load_config()


def handler(event, context):
    """Process SQS messages and launch ECS scorer tasks.

    Args:
        event: SQS event containing submission records.
        context: Lambda context object.

    Returns:
        dict: Response with status code.
    """
    for record in event['Records']:
        submission = json.loads(record['body'])

        # Handle SNS wrapper if present
        if 'Message' in submission:
            submission = json.loads(submission['Message'])

        try:
            # Fire and forget - returns immediately after task launch
            task_arn = run_scorer_task(config, submission)
            print(f"Launched ECS task {task_arn} for submission {submission['id']}")

        except Exception as e:
            print(f"Failed to launch task for submission {submission['id']}: {e}")
            raise  # Let SQS retry via DLQ

    return {'statusCode': 200}
