"""Validation logic for submission messages."""


def validate_submission(message: dict) -> bool:
    """Validate submission message has required fields.

    Args:
        message: The submission message dictionary.

    Returns:
        True if all required fields are present, False otherwise.
    """
    required_fields = ['id', 'challengeId', 'url', 'memberId']
    return all(field in message for field in required_fields)
