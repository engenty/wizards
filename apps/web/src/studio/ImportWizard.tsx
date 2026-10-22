import type { ValidationIssue } from "@engenty/wizards-shared/definition";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useRef } from "react";
import { useNavigate } from "react-router";
import { ApiError, api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useCurrentProject, useMayCreate } from "../lib/session";
import { Button, Dialog } from "../ui";

/** Makes a new wizard in the current project of a package (`.wizard`) and opens it. */
export function ImportWizard({
  variant = "secondary",
  label = t("home.import"),
}: {
  variant?: "secondary" | "ghost";
  label?: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { project } = useCurrentProject();
  const build = useMayCreate();
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) =>
      api.upload<{ id: string }>(`/api/studio/projects/${project!.id}/wizards/import`, file),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: keys.spaces() });
      await qc.invalidateQueries({ queryKey: ["wizards"] });
      navigate(`/edit/${id}`);
    },
  });
  const issues: ValidationIssue[] =
    upload.error instanceof ApiError ? (upload.error.body?.issues ?? []) : [];
  // Importing makes a wizard: not offered where nothing is made, or the project is not changed here.
  if (!build || project?.readOnly) {
    return null;
  }
  return (
    <>
      <Button
        variant={variant}
        busy={upload.isPending}
        disabled={!project}
        onClick={() => input.current?.click()}
      >
        <Upload className="size-4" /> {label}
      </Button>
      <input
        ref={input}
        hidden
        type="file"
        // No `accept`: a phone greys out files whose extension it does not know.
        onChange={(e) => {
          const file = e.target.files?.[0];
          // The same file can be picked again after a failed try.
          e.target.value = "";
          if (file) {
            upload.mutate(file);
          }
        }}
      />
      <Dialog open={upload.isError} onClose={upload.reset} title={t("import.failed")}>
        <p className="text-[0.875rem] text-ink-2">{(upload.error as Error | null)?.message}</p>
        {issues.length ? (
          <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-[0.8125rem] text-ink-2">
            {issues.slice(0, 8).map((i) => (
              <li key={i.message}>{i.message}</li>
            ))}
          </ul>
        ) : null}
        <div className="mt-5 flex justify-end">
          <Button variant="secondary" onClick={upload.reset}>
            {t("common.close")}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
