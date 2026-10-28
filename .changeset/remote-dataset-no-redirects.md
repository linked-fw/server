---
'@_linked/server': patch
---

`RemoteDataset`'s url form never follows a redirect: a 3xx answer is a `RemoteDatasetError` with
its status, so the bearer, the user's token and its proof are sent to the configured data server
only.
