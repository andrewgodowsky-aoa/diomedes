/** Public terms only. Company economics belong in the private commercial rate card. */
export function ManagedInferencePolicy() {
  return (
    <section aria-label="Nectovia-managed AI">
      <h3>Nectovia-managed AI</h3>
      <p className="prose">
        Nectovia-managed AI is the default for paid Agent work. Any included allowance is used first,
        with model routing managed by Nectovia.
      </p>
      <p className="caption">
        Additional managed usage is billed at Nectovia's current usage rate. It requires your
        organization's authorization and a monthly spending cap; it never starts automatically.
        A higher limit for one job does not authorize extra monthly spending.
      </p>
      <p className="caption">
        To arrange additional usage, contact Diomedes Systems at{' '}
        <a href="mailto:hello@diomedes.net">hello@diomedes.net</a> for the current rate and spending limit.
      </p>
      <details>
        <summary>Advanced: organization-owned API or cloud account</summary>
        <p className="caption">
          Supported commercial API or cloud credentials are an optional, contract-specific setup.
          Contact Diomedes Systems to confirm eligibility. Your provider bills that usage separately;
          it does not use your included Nectovia allowance or grant Nectovia Agent access.
        </p>
        <p className="caption">
          Consumer, Pro, Max, Team and Business AI subscriptions cannot fund shared organization-wide
          Nectovia Agent work. A permitted subscription-backed external engine is for its licensed
          user on that user's device, subject to the provider's rules.
        </p>
      </details>
    </section>
  );
}
