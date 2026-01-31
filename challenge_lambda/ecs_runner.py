"""ECS task runner for launching scorer tasks."""
import os
import boto3

ecs = boto3.client('ecs')


def run_scorer_task(config: dict, submission: dict) -> str:
    """Launch ECS Fargate task asynchronously (fire and forget).

    Args:
        config: Challenge configuration containing ECS cluster and task definition.
        submission: Submission data containing id, url, and memberId.

    Returns:
        str: The ARN of the launched ECS task.
    """
    response = ecs.run_task(
        cluster=config['ecsCluster'],
        taskDefinition=config['ecsTaskDefinition'],
        launchType='FARGATE',
        networkConfiguration={
            'awsvpcConfiguration': {
                'subnets': os.environ['SUBNETS'].split(','),
                'securityGroups': [os.environ['SECURITY_GROUP']],
                'assignPublicIp': 'DISABLED'
            }
        },
        overrides={
            'containerOverrides': [{
                'name': 'scorer',
                'environment': [
                    {'name': 'SUBMISSION_ID', 'value': submission['id']},
                    {'name': 'CHALLENGE_ID', 'value': config['challengeId']},
                    {'name': 'SUBMISSION_URL', 'value': submission['url']},
                    {'name': 'MEMBER_ID', 'value': str(submission['memberId'])}
                ]
            }]
        }
    )

    task_arn = response['tasks'][0]['taskArn']
    return task_arn
