/**
 * A mistake in what a person sent (an empty name, a sort with no printer),
 * as opposed to a RangeError the server's own code or a library raises. The
 * app API answers it with 400 and its message; any other RangeError is a
 * logged 500 that does not echo the message (issue #473). It is a RangeError
 * too, so callers that catch RangeError still do.
 */
export class SettingsInputError extends RangeError {
  override readonly name = "SettingsInputError";
}
