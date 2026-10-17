import type { Folder, Node } from "fumadocs-core/page-tree";
import { Card, Cards } from "fumadocs-ui/components/card";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";
import { releaseUrl } from "@/lib/site";
import { source } from "@/lib/source";

/** The sections: the folders of docs/content whose meta.json says `"root": true`. */
function sections(): Folder[] {
  const isSection = (node: Node): node is Folder => node.type === "folder" && node.root === true;
  return source.getPageTree().children.filter(isSection);
}

/** A root folder gets no `index` from fumadocs, so a section opens at its first page. */
function firstPageUrl(folder: Folder): string | undefined {
  if (folder.index) return folder.index.url;
  for (const node of folder.children) {
    if (node.type === "page") return node.url;
    if (node.type === "folder") {
      const url = firstPageUrl(node);
      if (url) return url;
    }
  }
}

/** The releases the pages were checked against, oldest and newest. */
function versions(): { oldest: string; newest: string } {
  const byRelease = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
  const all = source
    .getPages()
    .map((page) => page.data.version)
    .sort(byRelease);
  return { oldest: all[0] ?? "", newest: all.at(-1) ?? "" };
}

export default function HomePage() {
  const { oldest, newest } = versions();
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-16">
        <div>
          <h1 className="font-semibold text-4xl tracking-tight">engenty wizards docs</h1>
          <p className="mt-3 text-fd-muted-foreground text-lg">
            Describe what you do again and again, and get a wizard for it: pages that ask, AI steps
            that do the work, a link to share. These pages show how to use it and how to extend it.
          </p>
          <p className="mt-3 text-fd-muted-foreground text-sm">
            {oldest === newest
              ? "Describes engenty wizards "
              : `Describes engenty wizards v${oldest} to `}
            <a className="underline" href={releaseUrl(newest)}>
              v{newest}
            </a>
          </p>
        </div>
        <Cards>
          {sections().map((section) => (
            <Card
              key={section.$id}
              href={firstPageUrl(section) ?? "/"}
              icon={section.icon}
              title={section.name}
              description={section.description}
            />
          ))}
        </Cards>
      </main>
    </HomeLayout>
  );
}
