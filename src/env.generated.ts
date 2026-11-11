/**
 * Generated from .env.schema by Varlock for Effect 4. Do not edit by hand.
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"

function redactErrors<A>(config: Config.Config<A>, key: string): Config.Config<A> {
  return Config.orElse(config, () => {
    const error = new Schema.SchemaError(
      new SchemaIssue.Pointer([key], new SchemaIssue.InvalidValue({ message: "<redacted>" })),
    )
    // Config.fail is typed as Config<unknown> in this Effect release, but never succeeds.
    return Config.fail(error) as Config.Config<never>
  })
}

export const config = Config.all({
  INFISICAL_PROJECT_ID: Config.String("INFISICAL_PROJECT_ID"),
  INFISICAL_IDENTITY_ID: Config.String("INFISICAL_IDENTITY_ID"),
  /**
   * The PKCS12 keystore exported from Morphe Manager, base64-encoded.
   */
  KEYSTORE_BASE64: redactErrors(
    Config.map(Config.String("KEYSTORE_BASE64"), Redacted.make),
    "KEYSTORE_BASE64",
  ),
  KEYSTORE_PASSWORD: redactErrors(
    Config.map(Config.String("KEYSTORE_PASSWORD"), Redacted.make),
    "KEYSTORE_PASSWORD",
  ),
  KEY_ALIAS: Config.String("KEY_ALIAS"),
  KEY_PASSWORD: redactErrors(
    Config.map(Config.String("KEY_PASSWORD"), Redacted.make),
    "KEY_PASSWORD",
  ),
})

/** Loads environment values when executed, converting config failures to defects. */
export const generated = config.pipe(Effect.orDie)
