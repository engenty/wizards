import { localeOf, wizardLang } from "@engenty/wizards-shared/definition";
import type { ContextService } from "@engenty/wizards-shared/run-services";
import { subjectsOf } from "../broker/rwx.js";
import { prepareInputs } from "../engine/prepare.js";
import type { RunRow, StepContext } from "../engine/types.js";
import { knowledgeBlock } from "../services/knowledge.js";
import { spaceContextOf } from "../tools/plugin.js";
import { skillsBlock, skillsOf } from "../tools/skills.js";

/**
 * What the model is told beside a step's task, from the run's space: its brand and files, its
 * Knowledge, its skills, what its plugins hold. `at`: the step context under a step's id.
 */
export function contextService(run: RunRow, at: (stepId: string) => StepContext): ContextService {
  return {
    async forStep(stepId, options = {}) {
      const c = at(stepId);
      const lang = wizardLang(run.definition);
      const knowledge = await knowledgeBlock(c.dataSpace.id, subjectsOf(c));
      const skills = skillsBlock(await skillsOf(c), {
        tools: options.tools ?? true,
        sandbox: options.sandbox === true && c.resources.sandboxCapabilities() !== null,
      });
      const plugins = await spaceContextOf(c);
      return {
        date: new Date().toLocaleDateString(localeOf(lang), {
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        lang,
        brand: c.scope.brand,
        files: c.spaceFiles.map(({ id, kind, name, mime, description }) => ({
          id,
          kind,
          name,
          mime,
          description,
        })),
        knowledge,
        skills,
        plugins: { blocks: plugins.blocks, html: plugins.html },
      };
    },
    prepareInputs: (stepId) => prepareInputs(at(stepId)),
  };
}
