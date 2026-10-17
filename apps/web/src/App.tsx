import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Mascot } from "./brand";
import { STUDIO } from "./lib/base";
import { useLang } from "./lib/i18n";
import { useAccountLang, useMe } from "./lib/session";
import { PluginFrame, startStudioPlugins, useStudioPlugins } from "./plugins/host";
import { AppFrame } from "./studio/AppFrame";
import { AssistantProvider } from "./studio/assistant/chat";
import { SignInPage } from "./studio/SignInPage";

// The public runner and the studio are separate bundles: a visitor never downloads the editor.
const PublicRunner = lazy(() =>
  import("./runner/PublicRunner").then((m) => ({ default: m.PublicRunner })),
);
const SharePage = lazy(() => import("./share/SharePage").then((m) => ({ default: m.SharePage })));
const EditorPage = lazy(() =>
  import("./studio/EditorPage").then((m) => ({ default: m.EditorPage })),
);
const HomePage = lazy(() => import("./studio/HomePage").then((m) => ({ default: m.HomePage })));
const OnboardingPage = lazy(() =>
  import("./studio/OnboardingPage").then((m) => ({ default: m.OnboardingPage })),
);
const NewWizardPage = lazy(() =>
  import("./studio/NewWizardPage").then((m) => ({ default: m.NewWizardPage })),
);
const SettingsPage = lazy(() =>
  import("./studio/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const ProjectPage = lazy(() =>
  import("./studio/ProjectPage").then((m) => ({ default: m.ProjectPage })),
);
const SetupPage = lazy(() => import("./studio/SetupPage").then((m) => ({ default: m.SetupPage })));

const ViewLab = import.meta.env.DEV
  ? lazy(() => import("./dev/ViewLab").then((m) => ({ default: m.ViewLab })))
  : null;
const EngentyBuilder = import.meta.env.DEV
  ? lazy(() => import("./dev/EngentyBuilder").then((m) => ({ default: m.EngentyBuilder })))
  : null;

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Mascot kind="round" size={56} />
    </div>
  );
}

/** `bare`: no frame at all (the setup). `full`: the frame, and the page fills it (the editor). */
function Studio({
  children,
  bare,
  wide,
  full,
}: {
  children: ReactNode;
  bare?: boolean;
  wide?: boolean;
  full?: boolean;
}) {
  const me = useMe();
  const location = useLocation();
  useAccountLang(me.data);
  // Signed in, the studio takes on the tenant's plugins.
  useEffect(() => {
    if (me.data) {
      startStudioPlugins(me.data);
    }
  }, [me.data]);
  if (me.isLoading) {
    return <Splash />;
  }
  if (!me.data) {
    return <SignInPage />;
  }
  // A runtime that runs alone is set up once, before anything else.
  if (me.data.mode === "local" && !me.data.setupDone && location.pathname !== "/setup") {
    return <Navigate to="/setup" replace />;
  }
  // A team's first visit of the cloud studio: who it is, its website, first documents, the space.
  if (me.data.onboarding && location.pathname !== "/start") {
    return <Navigate to="/start" replace />;
  }
  return bare ? (
    children
  ) : (
    <AppFrame me={me.data} wide={wide} full={full}>
      {children}
    </AppFrame>
  );
}

/** The public pages: a wizard's link and a shared result, at the root of the host. */
export function PublicApp() {
  useLang();
  return (
    <Suspense fallback={<Splash />}>
      <Routes>
        {EngentyBuilder && <Route path="/dev/engenty-builder" element={<EngentyBuilder />} />}
        {ViewLab && <Route path="/dev/views" element={<ViewLab />} />}
        <Route path="/w/:token" element={<PublicRunner />} />
        <Route path="/w/:token/steps" element={<PublicRunner steps />} />
        <Route path="/w/:token/steps/:runId" element={<PublicRunner steps />} />
        <Route path="/w/:token/chat" element={<PublicRunner chat />} />
        <Route path="/w/:token/chat/:runId" element={<PublicRunner chat />} />
        <Route path="/w/:token/talk" element={<PublicRunner chat talk />} />
        <Route path="/w/:token/talk/:runId" element={<PublicRunner chat talk />} />
        <Route path="/w/:token/video" element={<PublicRunner chat video />} />
        <Route path="/w/:token/video/:runId" element={<PublicRunner chat video />} />
        <Route path="/w/:token/:runId" element={<PublicRunner />} />
        <Route path="/s/:token" element={<SharePage />} />
        <Route path="*" element={<ToStudio />} />
      </Routes>
    </Suspense>
  );
}

/** In development every address is the app's; built, the server sends only these here. */
function ToStudio() {
  useEffect(() => {
    window.location.replace(`${STUDIO}/`);
  }, []);
  return <Splash />;
}

/** An address the studio does not know: a plugin's page that is still loading, or nothing. */
function Unknown() {
  const plugins = useStudioPlugins();
  return plugins.status === "ready" ? <Navigate to="/" replace /> : <Splash />;
}

/** The studio, below `/studio`: its addresses are written as if it stood at the root. */
export function StudioApp() {
  // A switch of language renders the whole app again, in place.
  useLang();
  // The studio's own sizes (app.css): smaller on laptops than a wizard's page.
  useEffect(() => {
    document.documentElement.dataset.studio = "";
    return () => {
      delete document.documentElement.dataset.studio;
    };
  }, []);
  const plugins = useStudioPlugins();
  return (
    // The assistant's chat stands above the pages: it stays while the person moves between them.
    <AssistantProvider>
      <Suspense fallback={<Splash />}>
        <Routes>
          <Route
            path="/"
            element={
              <Studio>
                <HomePage />
              </Studio>
            }
          />
          <Route
            path="/sign-in"
            element={
              <Studio>
                <Navigate to="/" replace />
              </Studio>
            }
          />
          <Route
            path="/new"
            element={
              <Studio>
                <NewWizardPage />
              </Studio>
            }
          />
          <Route
            path="/edit/:id"
            element={
              <Studio full>
                <EditorPage />
              </Studio>
            }
          />
          <Route
            path="/space/:group?"
            element={
              <Studio wide>
                <ProjectPage />
              </Studio>
            }
          />
          <Route
            path="/settings/:section?"
            element={
              <Studio wide>
                <SettingsPage />
              </Studio>
            }
          />
          <Route
            path="/setup"
            element={
              <Studio bare>
                <SetupPage />
              </Studio>
            }
          />
          <Route
            path="/start"
            element={
              <Studio bare>
                <OnboardingPage />
              </Studio>
            }
          />
          {plugins.pages.map((page) => (
            <Route
              key={page.serial}
              path={page.path}
              element={
                <Studio wide={page.wide}>
                  <PluginFrame of={page}>
                    <page.component />
                  </PluginFrame>
                </Studio>
              }
            />
          ))}
          <Route
            path="*"
            element={
              <Studio bare>
                <Unknown />
              </Studio>
            }
          />
        </Routes>
      </Suspense>
    </AssistantProvider>
  );
}
