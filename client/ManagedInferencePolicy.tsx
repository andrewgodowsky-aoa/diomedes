/** Public terms only. Company economics belong in the private commercial rate card. */
export function ManagedInferencePolicy() {
  return (
    <section aria-label="Nectovia-managed AI">
      <h3>Nectovia-managed AI</h3>
      <p className="prose">
        By default, paid Agent work uses Nectovia's AI and draws from your included allowance first.
      </p>
      <p className="caption">
        Extra usage needs your business's approval and a monthly spending limit. It's billed at Nectovia's current rate.
        Raising one job's limit doesn't approve extra monthly spending.
      </p>
      <p className="caption">
        To arrange additional usage, contact Diomedes Systems at{' '}
        <a href="mailto:hello@diomedes.net">hello@diomedes.net</a> for the current rate and spending limit.
      </p>
      <details>
        <summary>Your business's own AI account</summary>
        <p className="caption">
          Contact Diomedes Systems to arrange a supported business AI account. The provider bills you separately.
          That usage doesn't use your Nectovia allowance.
          You still need a plan that includes the Nectovia Agent.
        </p>
        <p className="caption">
          AI subscriptions can't fund shared Agent work. Supported subscriptions cover the licensed person's work on their device,
          under the provider's terms.
        </p>
      </details>
    </section>
  );
}
