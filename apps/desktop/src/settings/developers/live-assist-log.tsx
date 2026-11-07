import { t } from "@lingui/core/macro";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@anlg/ui/components/ui/button";
import { toast } from "@anlg/ui/components/ui/toast";

import {
  copyLiveAssistJournal,
  saveLiveAssistJournal,
} from "~/session/live-assist/journal";

export function LiveAssistLogSection() {
  const copy = useMutation({
    mutationFn: copyLiveAssistJournal,
    onSuccess: () => toast.success(t`Live Assist log copied.`),
    onError: (error) => toast.error(error.message),
  });
  const save = useMutation({
    mutationFn: saveLiveAssistJournal,
    onSuccess: () => toast.success(t`Live Assist log saved to Downloads.`),
    onError: (error) => toast.error(error.message),
  });

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-sans text-lg font-semibold">{t`Live Assist log`}</h2>
      <p className="text-muted-foreground text-sm">
        {t`Everything Live Assist did since BlackMushi started: prompts, model answers and template choices. It includes excerpts of your calls and only leaves your computer if you share it.`}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={copy.isPending}
          onClick={() => copy.mutate()}
        >
          {t`Copy`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {t`Save`}
        </Button>
      </div>
    </section>
  );
}
