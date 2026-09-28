# shellcheck shell=bash
# Sourced, not run -- no shebang needed at runtime, but shellcheck still has to be told the
# dialect since both callers are bash and the arrays below use bash-only syntax.
#
# Shared MX Ergo S target-state definitions, sourced by both mx-ergo-solaar (which asserts them
# on every connect) and mx-ergo-resync (which asserts the same values by hand and verifies them).
# The two scripts used to each carry their own copy of these arrays -- two encodings of "what
# state is correct" that could drift apart from each other without either script's tests noticing.
#
# Only the middle button is diverted -- it is the precision hold. Everything else must be Regular
# or the device stops sending those events at all.
# shellcheck disable=SC2034  # both arrays are used by the scripts that source this file
MX_ERGO_DIVERSIONS=(
    "Middle Button:Diverted"
    "Back Button:Regular"
    "Forward Button:Regular"
    "Left Tilt:Regular"
    "Right Tilt:Regular"
    "DPI Switch:Regular"
)

# Control -> intended action. Only the two this setup actually moves; the rest keep whatever they
# have. Middle Button's action is unused while it is diverted, but asserting it means the button
# degrades to a plain middle click if Solaar stops.
# shellcheck disable=SC2034  # both arrays are used by the scripts that source this file
MX_ERGO_ACTIONS=(
    "Middle Button:Mouse Middle Button"
    "DPI Switch:Mouse Middle Button"      # the clicks the middle button gave up
)
