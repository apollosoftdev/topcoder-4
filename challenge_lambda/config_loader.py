"""Configuration loader with SSM caching for challenge Lambda."""
import os
import json
import boto3

# Module-level cache - persists across warm invocations
_cached_config = None


def load_config():
    """Load challenge config from SSM at cold start, cache for warm starts.

    Returns:
        dict: The challenge configuration loaded from SSM Parameter Store.
    """
    global _cached_config

    if _cached_config is not None:
        return _cached_config

    ssm = boto3.client('ssm')
    challenge_id = os.environ['CHALLENGE_ID']

    response = ssm.get_parameter(
        Name=f'/mm-processor/challenges/{challenge_id}/config',
        WithDecryption=True
    )

    _cached_config = json.loads(response['Parameter']['Value'])
    print(f"Loaded config for challenge {challenge_id}")
    return _cached_config


def invalidate_cache():
    """Invalidate the cached config. Useful for testing."""
    global _cached_config
    _cached_config = None
