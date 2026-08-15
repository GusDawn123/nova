import type { JSX } from "react";

import { ExternalIcon } from "../../design/icons";
import {
  HelpTargetIcon,
  MailIcon,
  QuestionIcon,
  ReleaseDocIcon,
} from "../icons";
import { SectionHead, SettingRow } from "../rows";

/** The About tab — release notes, support rows, and the installed version. */
export function AboutTab(): JSX.Element {
  return (
    <>
      <SectionHead
        title="About"
        sub="Release notes, support, and app information"
      />
      <div className="about__release">
        <span className="srow__icon">
          <ReleaseDocIcon />
        </span>
        <div className="about__release-body">
          <span className="about__release-head">
            <span className="about__release-title">Welcome to Nova 2.0</span>
            <span className="about__release-date">April 3, 2026</span>
          </span>
          <span className="about__release-summary">
            Nova 2.0 is a complete rewrite focused on reliability, speed, and a
            smoother day-to-day experience.
          </span>
          <ul className="about__release-list">
            <li className="about__release-item">
              AI chat responds faster, with time to first token decreased by
              50%.
            </li>
            <li className="about__release-item">
              Long meetings keep better context, including earlier details that
              matter later.
            </li>
            <li className="about__release-item">
              File search is improved so modes can reference large uploaded
              documents more reliably.
            </li>
          </ul>
        </div>
      </div>

      <SettingRow
        icon={<HelpTargetIcon />}
        title="Help Center"
        desc="Find answers and setup help."
      >
        <button type="button" className="btn-outline">
          Open
          <ExternalIcon size={14} />
        </button>
      </SettingRow>
      <SettingRow
        icon={<MailIcon />}
        title="Contact Support"
        desc="Reach the Nova team directly."
      >
        <button type="button" className="btn-outline">
          Email
          <ExternalIcon size={14} />
        </button>
      </SettingRow>
      <SettingRow
        icon={<QuestionIcon />}
        title="Nova Version"
        desc="The desktop version currently installed."
      >
        <span className="about__version">2.1.20</span>
      </SettingRow>
    </>
  );
}
