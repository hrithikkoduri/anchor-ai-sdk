# Working Notes

## Issue
Users want to concatenate xarray Datasets with different variables without manually creating dummy variables.

## Current behavior
- `xarray.concat` raises a `ValueError` when trying to concatenate datasets with different variables
- Error message: "variables {'b'} are present in some datasets but not others."

## Requested feature
Add an option (default?) to handle missing variables gracefully, similar to pandas.concat which does an outer join.

## Implementation plan
Looking at the code, I see that:
1. The function already has a `fill_value` parameter (default=dtypes.NA)
2. The function already has a `join` parameter for combining indexes
3. The issue is in lines 314-320 of concat.py where it raises an error for absent_merge_vars

The solution is to:
1. Modify the logic in _dataset_concat to handle missing variables gracefully
2. When a variable is missing in some datasets, we should:
   - Not include it in variables_to_merge if it's not in all datasets
   - Or fill it with fill_value

## Key locations
- xarray/core/concat.py: concat() and _dataset_concat() functions (lines 314-320)
- xarray/tests/test_concat.py: tests for the new functionality

## Key insight
The variables that are not being concatenated (variables_to_merge) should handle missing variables by:
1. Finding the union of all variables across all datasets
2. Filling missing variables with fill_value

This should be the default behavior to match pandas.concat!
