import { useState, type JSX } from "react";

/**
 * The Billing tab: monthly/annual chips, the two plan cards, and the free
 * plan row — verbatim from the mockup. Prices are the mockup's; nothing here
 * touches a payment provider.
 */
export function BillingTab(): JSX.Element {
  const [period, setPeriod] = useState<"monthly" | "annual">("annual");
  const isAnnual = period === "annual";

  return (
    <>
      <div className="billing__period">
        <div className="billing__period-box">
          <button
            type="button"
            className={periodChip(!isAnnual)}
            onClick={() => {
              setPeriod("monthly");
            }}
          >
            Monthly
          </button>
          <button
            type="button"
            className={periodChip(isAnnual)}
            onClick={() => {
              setPeriod("annual");
            }}
          >
            Annual
            {isAnnual && <span className="billing__save-badge">Save 45%</span>}
          </button>
        </div>
      </div>

      <div className="billing__cards">
        <div className="plan plan--pro">
          <span className="plan__name">Pro plan</span>
          <div className="plan__price-row">
            {isAnnual && <span className="plan__strike">$19.99</span>}
            <span className="plan__price">
              {isAnnual ? "$11.99" : "$19.99"}
            </span>
            <span className="plan__cadence">/month</span>
          </div>
          <div className="plan__divider" />
          <div className="plan__features">
            <span className="plan__feature">
              <span className="plan__badge">∞</span>Unlimited AI Responses
            </span>
            <span className="plan__feature">
              <span className="plan__badge">∞</span>Unlimited audio sessions
            </span>
            <span className="plan__feature">
              <span className="plan__badge">✓</span>Access to newest AI models
            </span>
            <span className="plan__feature">
              <span className="plan__badge">✓</span>Priority chat support
            </span>
          </div>
          <button type="button" className="plan__cta">
            Upgrade
            {isAnnual && <span className="plan__cta-badge">-45%</span>}
          </button>
        </div>

        <div className="plan plan--undetect">
          <span className="plan__name-row">
            <span className="plan__name">Pro + Undetectability</span>
            <span className="plan__popular">Popular</span>
          </span>
          <div className="plan__price-row">
            {isAnnual && <span className="plan__strike">$149.99</span>}
            <span className="plan__price">
              {isAnnual ? "$79.99" : "$149.99"}
            </span>
            <span className="plan__cadence">/month</span>
          </div>
          <div className="plan__divider" />
          <div className="plan__hero-feature">
            <span className="plan__hero-badge">✓</span>
            <div className="plan__hero-text">
              <span className="plan__hero-title">Nova Undetectability</span>
              <span className="plan__hero-desc">
                Nova stays hidden from screen share and recordings
              </span>
            </div>
          </div>
          <div className="plan__art">
            <span className="plan__art-label">undetectability art</span>
          </div>
          <button type="button" className="plan__cta">
            Upgrade
            {isAnnual && <span className="plan__cta-badge">-45%</span>}
          </button>
        </div>
      </div>

      <div className="billing__divider" />

      <div className="billing__free">
        <div className="billing__free-head">
          <span className="billing__free-label">Free plan</span>
          <span className="billing__free-price">$0</span>
        </div>
        <div className="billing__free-grid">
          <span className="billing__free-item">
            <span className="billing__free-badge">✓</span>Limited AI usage per
            meeting
          </span>
          <span className="billing__free-item">
            <span className="billing__free-badge">✓</span>Limited free meetings
          </span>
          <span className="billing__free-item">
            <span className="billing__free-badge">✓</span>Ask AI about past
            meetings
          </span>
          <span className="billing__free-item">
            <span className="billing__free-badge">✓</span>Customize AI
            instructions
          </span>
        </div>
      </div>
    </>
  );
}

function periodChip(on: boolean): string {
  return on
    ? "billing__period-chip billing__period-chip--on"
    : "billing__period-chip";
}
