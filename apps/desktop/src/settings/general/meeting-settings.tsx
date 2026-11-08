import { Trans, useLingui } from "@lingui/react/macro";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { platform } from "@tauri-apps/plugin-os";

import { Button } from "@anlg/ui/components/ui/button";
import { Input } from "@anlg/ui/components/ui/input";
import { toast } from "@anlg/ui/components/ui/toast";

import { askProject, listProjects } from "~/session/live-assist/projects";
import { setSettingValue } from "~/settings/queries";
import { SettingRow, SettingSwitchRow } from "~/settings/setting-row";
import { useConfigValue } from "~/shared/config";

interface SettingItem {
  value: boolean;
  onChange: (value: boolean) => void;
}

export function MeetingSettingsView({
  autoJoinScheduledMeetings,
  autoStartScheduledMeetings,
  autoStopMeetings,
  autoRecordDetectedMeetings,
  floatingBar,
  meetingDisclosureAutoPost,
  captureMeetingChat,
  liveAssistEnabled,
  liveAssistWebResearch,
  liveAssistAutoAnswers,
  captureSharedScreens,
}: {
  autoJoinScheduledMeetings: SettingItem;
  autoStartScheduledMeetings: SettingItem;
  autoStopMeetings: SettingItem;
  autoRecordDetectedMeetings: SettingItem;
  floatingBar: SettingItem;
  meetingDisclosureAutoPost: SettingItem;
  captureMeetingChat: SettingItem;
  liveAssistEnabled: SettingItem;
  liveAssistWebResearch: SettingItem;
  liveAssistAutoAnswers: SettingItem;
  captureSharedScreens: SettingItem;
}) {
  const currentPlatform = platform();
  const supportsMeetingAx =
    currentPlatform === "macos" || currentPlatform === "linux";
  const supportsMicDetection = currentPlatform !== "windows";
  const supportsScreenCapture =
    currentPlatform === "macos" || currentPlatform === "windows";

  return (
    <div className="flex flex-col gap-4">
      <SettingSwitchRow
        title={<Trans>Start when meeting begins</Trans>}
        description={
          <Trans>Start listening when a scheduled meeting begins.</Trans>
        }
        checked={autoStartScheduledMeetings.value}
        onChange={autoStartScheduledMeetings.onChange}
      />
      <SettingSwitchRow
        title={<Trans>Join scheduled meetings</Trans>}
        description={
          <Trans>Open the meeting link when a scheduled meeting begins.</Trans>
        }
        checked={autoJoinScheduledMeetings.value}
        onChange={autoJoinScheduledMeetings.onChange}
        disabled={!autoStartScheduledMeetings.value}
      />
      {supportsMicDetection && (
        <SettingSwitchRow
          title={<Trans>Stop when meeting ends</Trans>}
          description={<Trans>Stop listening when your call ends.</Trans>}
          checked={autoStopMeetings.value}
          onChange={autoStopMeetings.onChange}
        />
      )}
      {supportsMeetingAx && (
        <>
          <SettingSwitchRow
            title={<Trans>Start when a meeting app is detected</Trans>}
            description={
              <Trans>
                Use Accessibility to detect Zoom, Google Meet, or Teams open
                with an active call, and start listening automatically, even
                without a scheduled meeting.
              </Trans>
            }
            checked={autoRecordDetectedMeetings.value}
            onChange={autoRecordDetectedMeetings.onChange}
          />
          <SettingSwitchRow
            title={<Trans>Post recording disclosure in meeting chat</Trans>}
            description={
              <Trans>
                Tell participants when listening starts; this does not confirm
                consent.
              </Trans>
            }
            checked={meetingDisclosureAutoPost.value}
            onChange={meetingDisclosureAutoPost.onChange}
          />
          <SettingSwitchRow
            title={<Trans>Capture meeting chat in Memos</Trans>}
            description={
              <Trans>
                Save visible chat from supported meetings using Accessibility.
              </Trans>
            }
            checked={captureMeetingChat.value}
            onChange={captureMeetingChat.onChange}
          />
        </>
      )}
      {supportsScreenCapture && (
        <SettingSwitchRow
          title={<Trans>Capture shared screens in Memos</Trans>}
          description={
            <Trans>
              Save slides and screens others share in meetings. Requires Screen
              Recording.
            </Trans>
          }
          checked={captureSharedScreens.value}
          onChange={captureSharedScreens.onChange}
        />
      )}
      <SettingSwitchRow
        title={<Trans>Show floating bar</Trans>}
        description={
          <Trans>Control listening without reopening BlackMushi.</Trans>
        }
        checked={floatingBar.value}
        onChange={floatingBar.onChange}
      />
      <SettingSwitchRow
        title={<Trans>Live Assist</Trans>}
        description={
          <Trans>
            While a meeting is transcribed live, the floating bar suggests the
            questions to ask, drafts the to-do and keeps a running summary.
            Sends the new transcript to your configured AI provider about once a
            minute.
          </Trans>
        }
        checked={liveAssistEnabled.value}
        onChange={liveAssistEnabled.onChange}
      />
      {liveAssistEnabled.value && (
        <SettingSwitchRow
          title={<Trans>Suggested answers</Trans>}
          description={
            <Trans>
              When someone asks you a question during the call, the floating bar
              suggests a short answer, using the call, your past meetings with
              the same people and the project's context. You can always ask your
              own questions in the Answers tab.
            </Trans>
          }
          checked={liveAssistAutoAnswers.value}
          onChange={liveAssistAutoAnswers.onChange}
        />
      )}
      {liveAssistEnabled.value && (
        <SettingSwitchRow
          title={<Trans>Web search for answers</Trans>}
          description={
            <Trans>
              Lets the model search the web when a question needs a recent or
              precise fact, through your AI provider's web search (Anthropic,
              OpenAI or Google). Each search is billed by your provider.
            </Trans>
          }
          checked={liveAssistWebResearch.value}
          onChange={liveAssistWebResearch.onChange}
        />
      )}
      {liveAssistEnabled.value && <ProjectsCommandRow />}
    </div>
  );
}

function ProjectsCommandRow() {
  const { t } = useLingui();
  const command = useConfigValue("projects_command");
  const save = useMutation({
    mutationFn: (value: string) =>
      setSettingValue("projects_command", value.trim()),
    onError: (error) => toast.error(error.message),
  });
  // Runs what a call will run: the list, then one question.
  const test = useMutation({
    mutationFn: async (value: string) => {
      const command = value.trim();
      const startedAt = Date.now();
      const projects = await listProjects(command);
      const listMs = Date.now() - startedAt;
      const askStartedAt = Date.now();
      const notes = await askProject(command, {
        question: t`Where does this project stand?`,
        origin: "asked",
        projectId: projects[0]?.id ?? null,
        call: { title: null, participants: [] },
        transcript: "",
      });
      return {
        count: projects.length,
        listMs,
        chars: notes.length,
        askMs: Date.now() - askStartedAt,
      };
    },
    onSuccess: ({ count, listMs, chars, askMs }) =>
      toast.success(
        t`${count} projects in ${listMs} ms. A test question returned ${chars} characters in ${askMs} ms.`,
      ),
    onError: (error) => toast.error(error.message),
  });
  const form = useForm({
    defaultValues: { command },
    onSubmit: ({ value }) => {
      if (value.command.trim() !== command) {
        save.mutate(value.command);
      }
    },
  });

  return (
    <SettingRow
      title={<Trans>Projects command</Trans>}
      description={
        <Trans>
          A command that gives answers the context of your projects. BlackMushi
          runs it with projects (a JSON list to pick from) and ask (the question
          and the call as JSON on stdin; it prints your notes). What it prints
          is sent to your AI provider.
        </Trans>
      }
      controlWidth="content"
    >
      {() => (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field name="command">
            {(field) => (
              <Input
                className="h-8 w-64 font-mono text-xs"
                placeholder="/usr/local/bin/my-tool anarlog"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={() => void form.handleSubmit()}
              />
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values.command}>
            {(value) => (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!value.trim() || test.isPending}
                onClick={() => test.mutate(value)}
              >
                <Trans>Test</Trans>
              </Button>
            )}
          </form.Subscribe>
        </form>
      )}
    </SettingRow>
  );
}
