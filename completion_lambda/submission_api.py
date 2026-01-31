"""API client for updating submission status."""
import os
import boto3
import requests

# Cache for auth token
_cached_token = None


def get_auth_token():
    """Get Auth0 token for API authentication.

    Returns:
        str: The authentication bearer token.
    """
    global _cached_token

    if _cached_token is not None:
        return _cached_token

    ssm = boto3.client('ssm')
    response = ssm.get_parameter(
        Name='/mm-processor/auth0/token',
        WithDecryption=True
    )
    _cached_token = response['Parameter']['Value']
    return _cached_token


def invalidate_token_cache():
    """Invalidate the cached token. Useful for testing or token refresh."""
    global _cached_token
    _cached_token = None


def update_submission_status(submission_id: str, status: str, task_arn: str, stopped_reason: str):
    """Update submission status via Topcoder Submission API.

    Args:
        submission_id: The unique identifier of the submission.
        status: The new status (e.g., 'SCORED', 'FAILED').
        task_arn: The ARN of the ECS task that processed the submission.
        stopped_reason: The reason the ECS task stopped.

    Raises:
        requests.HTTPError: If the API request fails.
    """
    api_url = os.environ['SUBMISSION_API_URL']
    token = get_auth_token()

    response = requests.patch(
        f"{api_url}/submissions/{submission_id}",
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        },
        json={
            'status': status,
            'metadata': {
                'taskArn': task_arn,
                'stoppedReason': stopped_reason
            }
        },
        timeout=30
    )
    response.raise_for_status()
