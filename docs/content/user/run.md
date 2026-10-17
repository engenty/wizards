---
title: Run a wizard
description: What you see when you open a wizard's link, on a computer or a phone.
version: 0.5.0
---

## From the link to the result

1. The link opens the wizard. “Let’s go” starts a run.
2. Pages ask their questions. “Continue” takes you to the next page, “Back” to the one before.
3. While an AI step works, the page says what it is doing. The screen stays on.
4. A review shows what was made. “Looks good” accepts it. “New version” asks for another one,
   with a note on what should change. “Edit” lets you change a text by hand.
5. The result page offers the downloads, “Copy text” and “Share”.

If you left a run, you can pick it up again with “Continue your last run”.

## As a chat

Where the owner switched it on, the wizard also runs as a chat, at `…/chat` or straight on its
link. It asks one question at a time. You answer in the composer or with the replies under the
question, and every answer stays in the chat. The composer has these buttons:

| Button | Does |
|---|---|
| Speaker (“Read aloud”) | Reads what the wizard says aloud, with the browser’s own voice in the wizard’s language. It costs nothing and stays on in this browser |
| Microphone (“Dictate”, ⌘⇧M, Ctrl⇧M on Windows) | Dictates into the composer. Where the browser can recognise speech, it writes along. Elsewhere the wizard’s own model writes the recording down when you stop, like a voice note |
| Phone (“Start talking”) | Starts a live conversation: you talk, and the wizard talks back and fills its pages from what you say, one question at a time. Files and signatures stay on the screen, and the wizard tells you so. The button is there only where the owner switched on live voice or the video call for the wizard (always in the owner’s test run), and for now only where the app that runs it has an OpenAI API key under Models |
| Camera, in a conversation | The wizard sees what you show it (“is the dent on the left?”) and takes photos into a photo field when you hold something still. The small picture shows what it sees |

When a step works on a website, the chat shows that page live with what the wizard just did.
“Take over” lets you click and type in it yourself while the wizard waits. “Hand back” lets the
wizard go on from where you left the page.

## As a live conversation

Where the owner switched it on, the wizard opens at `…/talk`, or straight on its link, as a
live audio screen. “Start talking” begins the conversation. The wizard’s engenty stands alone
in the middle: it breathes while it speaks and glows while it listens. The whole transcript of
what either of you said runs under it, with “Mute”, the camera and “Leave” underneath. The chat
sits beside it as the screen the wizard draws on. If you switch the camera on, it becomes the
video call below.

## As a video call

Where the owner switched it on, the wizard runs as a call, at `…/video` or straight on its link.
A stage shows your camera and the wizard’s engenty as the two on the call, with what either of
you said as captions. The controls underneath are “Mute”, the camera, “Switch camera” on a phone
and “Leave”. The chat sits beside the stage (under it on a phone) and is the screen the wizard
draws on: the questions and answers as they go, a photo field filled from the camera, a
signature or a file where only the screen can take it, and the result at the end.

“Let’s go” starts the run, and “Join” starts the call. Your browser then asks for the microphone
and the camera. The conversation is the same as the chat’s live voice, with the camera on from
the start. For now it needs an OpenAI API key under Models.

## On a phone

| The wizard asks for | The phone gives |
|---|---|
| Photos | The camera, page after page, or pictures from the library |
| A paper | The camera as a scanner |
| A short clip | The camera, up to 30 seconds |
| A serial or ticket number | “Scan” reads a QR code or barcode |
| Where you are | “Use my location”, with its accuracy. You can type an address instead |
| What happened | “Record a voice note”, up to 5 minutes |
| A sign-off | “Sign here”, with your finger |

Your browser asks before it uses the camera, the microphone or your location. If you denied one,
allow it in your browser’s site settings (the lock icon in the address bar). Or use the fallback
the field offers: choose a photo, type the address or choose an audio file.

With “Tell me when it’s done” you can switch apps during a long step: a notification, a sound
or a buzz brings you back. “Add to home screen” puts the wizard on your phone like an app. On a
computer, “Bookmark this wizard” shows how to keep it in your bookmarks.

## When the wizard needs you

| It shows | Because | You |
|---|---|---|
| A website live, with a sign-in | A step met a login, a captcha or “continue with Google” | Fill in the fields shown, or click and type in the live page itself. Then choose “Sign in” or “I’m signed in”. What you enter goes straight into the page, and the AI never sees it. “Remember this sign-in for next time” stores it encrypted. “Skip” goes on without the site |
| “The wizard wants to run this in …” | A step wants to change something in a service you connected | Choose “Allow”, “Allow for the rest of this run” or “Don’t allow”. Reading doesn’t ask, deleting always does |
| “Connect” | The wizard works with your own account of a service | Sign in to the service in a new tab. The connection is kept for your next run |

## What this wizard remembers

A wizard can keep lists, files and connected accounts for your next run. Only you see them.
The link “What this wizard remembers” below the wizard’s pages shows what is kept, and “Delete
everything” deletes it. Anything nobody used for 400 days is deleted by itself.

## Share a result

“Share” on the result page makes a link to the result. You can copy it, send it by email or hand
it to another app. When you ran the wizard over its link, the result and its link are kept for 7
days. “Withdraw link” ends the link earlier.

Media made by a model carries an “AI-generated” label. Whoever publishes it has to label it as
AI-generated. The file already carries the marking.
