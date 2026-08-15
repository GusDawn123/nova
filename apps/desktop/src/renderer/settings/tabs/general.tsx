import { useState, type JSX } from "react";

import {
  AudioBarsIcon,
  ExternalIcon,
  EyeIcon,
  IncognitoIcon,
  RefreshIcon,
} from "../../design/icons";
import { useScreenPrivacy } from "../../hooks/use-screen-privacy";
import {
  DownloadIcon,
  LogoutIcon,
  MicIcon,
  PowerIcon,
  QuitIcon,
  TranslateIcon,
  WavesIcon,
} from "../icons";
import { SectionHead, SettingRow, Toggle } from "../rows";

/**
 * The General tab. One control is real: Undetectability drives the same
 * screen-capture exclusion the pill's eye does, over the same IPC seam.
 * Everything else is the ratified design with presentational state.
 */
export function GeneralTab(): JSX.Element {
  const { enabled: undetectable, request } = useScreenPrivacy();
  const [launchAtLogin, setLaunchAtLogin] = useState(true);

  return (
    <>
      <SectionHead
        title="Updates"
        sub="Check for the latest Nova desktop release"
      />
      <SettingRow
        icon={<DownloadIcon />}
        title="Nova Version"
        desc="You are currently using Nova version 2.1.20"
      >
        <button type="button" className="btn-outline">
          Check for updates
        </button>
      </SettingRow>

      <SectionHead spaced title="General" sub="Customize how Nova works for you" />
      <SettingRow
        icon={
          undetectable ? <IncognitoIcon size={22} /> : <EyeIcon size={22} />
        }
        title="Undetectability"
        desc="Off means Nova is detectable by screen sharing."
      >
        <Toggle
          on={undetectable}
          label="Undetectability"
          onToggle={() => {
            request(!undetectable);
          }}
        />
      </SettingRow>
      <SettingRow
        icon={<PowerIcon />}
        title="Launch Nova at login"
        desc="Nova will open automatically when you log in."
      >
        <Toggle
          on={launchAtLogin}
          label="Launch Nova at login"
          onToggle={() => {
            setLaunchAtLogin((current) => !current);
          }}
        />
      </SettingRow>

      <div className="section-head section-head--spaced">
        <span className="section-title">Meetings</span>
      </div>
      <div className="meetings-card">
        <div className="meetings-card__body">
          <div className="meetings-card__row">
            <span className="meetings-card__icon">
              <AudioBarsIcon size={20} />
            </span>
            <div className="meetings-card__text">
              <span className="srow__title">Free meetings</span>
              <span className="srow__desc">
                0 free meetings or audio sessions left
              </span>
            </div>
            <span className="meetings-card__count">0/3</span>
          </div>
          <div className="meetings-card__meter" />
          <span className="meetings-card__note">
            Free usage is shared between scheduled meetings and audio sessions.
          </span>
        </div>
        <button type="button" className="meetings-card__upgrade">
          <span className="pro-chip">Pro</span>
          <div className="meetings-card__text">
            <span className="meetings-card__upgrade-title">
              Upgrade for unlimited meetings
            </span>
            <span className="srow__desc">
              Unlock unlimited meetings and audio sessions
            </span>
          </div>
          <span className="meetings-card__upgrade-arrow">
            <ExternalIcon />
          </span>
        </button>
      </div>

      <SectionHead
        spaced
        title="Language"
        sub="Choose how Nova listens and responds during meetings"
      />
      <SettingRow
        icon={<WavesIcon />}
        title="Transcription language"
        desc="Select the language you speak in meetings."
      >
        <select className="select" defaultValue="English (recommended)">
          <option>English (recommended)</option>
          <option>Spanish</option>
          <option>Portuguese</option>
          <option>French</option>
          <option>German</option>
        </select>
      </SettingRow>
      <SettingRow
        icon={<TranslateIcon />}
        title="Output language"
        desc="Your preferred language for AI and meeting notes."
      >
        <select className="select" defaultValue="English">
          <option>English</option>
          <option>Spanish</option>
          <option>Portuguese</option>
          <option>French</option>
          <option>German</option>
        </select>
      </SettingRow>

      <SectionHead
        spaced
        title="Audio Settings"
        sub="Test your audio input before you hop into a call"
      />
      <SettingRow
        icon={<MicIcon />}
        title="Microphone Source"
        desc="Default - System Microphone (Built-in)"
      >
        <button type="button" className="btn-outline">
          Test Microphone
        </button>
      </SettingRow>

      <div className="general__footer">
        <span className="general__footer-label">Account and app</span>
        <button type="button" className="general__footer-action">
          <RefreshIcon size={16} />
          Reset onboarding
        </button>
        <button type="button" className="general__footer-action">
          <LogoutIcon />
          Log out
        </button>
        <button type="button" className="general__footer-action">
          <QuitIcon />
          Quit
        </button>
      </div>
    </>
  );
}
