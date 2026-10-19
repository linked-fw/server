---
'@_linked/server': minor
---

`RemoteDataset.init()` now resolves the data server's `ping` body, and the store keeps it as the readonly `info` (type `RemoteDatasetPingInfo`). A gateway that names the dataset it serves (for example `{ok, projectId, branchName, dataset, forked}`) lets an app log at startup which dataset its data goes to. The no-url form resolves `undefined`, as before.
