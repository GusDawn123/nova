import { useState, type JSX } from "react";

import { MeetingAlertIcon } from "../icons";
import { SectionHead, SettingRow, Toggle } from "../rows";

/** The Notifications tab — one presentational toggle, per the mockup. */
export function NotificationsTab(): JSX.Element {
  const [scheduled, setScheduled] = useState(true);

  return (
    <>
      <SectionHead
        title="Notifications"
        sub="Choose when Nova should prompt you before calls"
      />
      <SettingRow
        icon={<MeetingAlertIcon />}
        title="Scheduled meetings"
        desc="Show notifications 1 minute before meetings start based on your Calendar."
      >
        <Toggle
          on={scheduled}
          label="Scheduled meeting notifications"
          onToggle={() => {
            setScheduled((current) => !current);
          }}
        />
      </SettingRow>
    </>
  );
}
