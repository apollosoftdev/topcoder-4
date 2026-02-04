# Verification Notes

This submission is for **Topcoder Marathon Match Scorer Rebuild POC Part 2 Relaunched**.

- Please refer to the updated `README.md` for setup and verification.
- **Submission API status updates are mocked** as confirmed by copilot (see [discussion](https://discussions.topcoder.com/discussion/36621/submission-status)).
- The `architecture.md` file is updated to reflect the current system, including SSM Parameter Store, Auth0 M2M proxy, and the Java scorer container.
- The scorer implementation itself is mocked and returns a dummy score. This is intentional, as the actual scorer logic is challenge-specific and not accessible in the dev environment. For future extensibility, mapping the sample challenge to the new scorer is recommended (see [discussion](https://discussions.topcoder.com/discussion/36632/test-challenge-in-dev-environment)).
- **Access token handling**: All API calls require a valid access token. The Submission Watcher Lambda now fetches a token dynamically at runtime via an Auth0 M2M client credentials flow (through a proxy) and injects it into the ECS task as `ACCESS_TOKEN`. No token is stored in Secrets Manager.

For all further details, configuration, and usage, see the main `README.md`.