Feature: Follow a failed test from its evidence to the statement that went wrong

  A test fails on a value that a helper had already returned, so the stack
  at the assertion no longer holds the helper. depug's reporter says so and
  prints a rerun line. The agent puts a verb in front of that line: frames
  names the helper's call, and flt follows that call statement by
  statement, so the agent reads the value instead of guessing it.

  Scenario: the evidence sends the agent to frames, and flt shows where the value went wrong
    Given a vitest project with depug's reporter and a test that fails on a value a helper already returned
    When the agent runs the test suite
    Then the failure prints an evidence file saying "the value's source already returned; rerun to reach it", and a rerun line starting with "npx depug rerun -- npx vitest run"
    When the agent puts frames in front of the rerun line
    Then the index names the helper's call under the function the test called
    When the agent puts flt with that call in front of the rerun line
    Then the trace shows the loop starting at the second price and the helper returning the short total
