import type { WizardDefinition } from "@engenty-wizards/shared/definition";

/**
 * The wizard the authoring guide shows as an example of the schema: a post with an image. It is
 * the guide's own, not a marketplace entry, so the guide never depends on the marketplace.
 */
export const EXAMPLE_WIZARD: WizardDefinition = {
  version: 1,
  title: "X post with an image",
  description: "Turns a topic into a finished post with an image.",
  avatar: "flame",
  lang: "en",
  intro: "Tell me briefly what it is about – I write the post and draw the image for it.",
  steps: [
    {
      id: "about",
      type: "page",
      title: "What is it about?",
      fields: [
        {
          id: "topic",
          label: "Topic or occasion",
          kind: "textarea",
          required: true,
          placeholder: "e.g. We open our new studio in Vienna on Friday",
        },
        {
          id: "tone",
          label: "Tone",
          kind: "select",
          options: ["Casual", "Professional", "Funny", "Inspiring"],
          default: "Casual",
        },
        { id: "link", label: "Link (optional)", kind: "url" },
      ],
    },
    {
      id: "post",
      type: "agent",
      title: "Write the post",
      working: "Writing the post …",
      instructions:
        "Write a post for X (Twitter) on the topic: {{topic}}. Tone: {{tone}}. At most 270 characters including the link, and at most two hashtags. If a link is given ({{link}}), put it at the end. A strong first sentence. Output only the post.",
      tools: [],
      output: { format: "text" },
      model: "standard",
    },
    {
      id: "visual",
      type: "generate",
      title: "Draw the image",
      working: "Drawing the image …",
      asset: "image",
      prompt:
        "A striking image to go with this post: {{steps.post}}. Topic: {{topic}}. No text in the image.",
      options: { aspectRatio: "16:9", style: "modern editorial, clean, high contrast" },
    },
    {
      id: "check",
      type: "review",
      title: "Does this work?",
      description: "You can change the text directly or ask for a new variant.",
      show: ["post", "visual"],
      edit: true,
      regenerate: true,
    },
    {
      id: "done",
      type: "result",
      title: "Ready to post",
      message: "Copy the text and download the image.",
      deliverables: [
        { from: "post", label: "Post", formats: ["txt", "md"] },
        { from: "visual", label: "Image", formats: ["png"] },
      ],
    },
  ],
};
