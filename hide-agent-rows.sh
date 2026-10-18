#!/bin/sh
# Hides every row of the agent panel below the prompt; side-monitor's pane shows agents instead.
exec jq -c '.tasks[]? | {id, content: ""}'
