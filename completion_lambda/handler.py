"""Completion Lambda handler for ECS task completion events."""
from submission_api import update_submission_status


def handler(event, context):
    """Handle ECS task completion events from EventBridge.

    Args:
        event: EventBridge event containing ECS task state change details.
        context: Lambda context object.

    Returns:
        dict: Response with status code.
    """
    detail = event['detail']
    task_arn = detail['taskArn']

    # Extract submission ID from container environment overrides
    submission_id = None
    for override in detail.get('overrides', {}).get('containerOverrides', []):
        if override.get('name') == 'scorer':
            for env in override.get('environment', []):
                if env['name'] == 'SUBMISSION_ID':
                    submission_id = env['value']
                    break

    if not submission_id:
        print(f"No submission ID found in task {task_arn}")
        return {'statusCode': 400}

    # Determine success/failure from container exit code
    containers = detail.get('containers', [])
    scorer_container = next((c for c in containers if c['name'] == 'scorer'), None)

    success = scorer_container and scorer_container.get('exitCode') == 0
    stopped_reason = detail.get('stoppedReason', '')

    # Update submission status via API
    status = 'SCORED' if success else 'FAILED'
    update_submission_status(
        submission_id=submission_id,
        status=status,
        task_arn=task_arn,
        stopped_reason=stopped_reason
    )

    print(f"Updated submission {submission_id} to {status}")
    return {'statusCode': 200}
