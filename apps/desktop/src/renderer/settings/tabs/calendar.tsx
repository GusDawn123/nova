import type { JSX } from "react";

import { CalendarIcon, GoogleIcon } from "../../design/icons";
import { SectionHead, SettingRow } from "../rows";

/** The Calendar tab — one connect row, per the mockup. Not wired yet. */
export function CalendarTab(): JSX.Element {
  return (
    <>
      <SectionHead
        title="Calendar"
        sub="Manage the calendar account Nova uses to show meetings and reminders."
      />
      <SettingRow
        icon={<CalendarIcon size={22} />}
        title="Google Calendar"
        desc="Connect a Google personal or workspace account."
      >
        <button type="button" className="btn-outline">
          <GoogleIcon />
          Connect
        </button>
      </SettingRow>
    </>
  );
}
