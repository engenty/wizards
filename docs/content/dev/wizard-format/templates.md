---
title: Templates
description: How instructions, prompts and briefs read answers, earlier results, the space and stored lists.
version: 0.7.10
---

Instructions, prompts and briefs are templates. `{{…}}` is filled in when the step runs:

```text
Write a post for X on {{topic}}. Tone: {{tone}}. Use these facts: {{steps.research}}
```

A template may only name fields asked and steps run earlier. `wizards validate` says when one
does not.

## What a template reads

| Template | What it gives |
|---|---|
| `{{fieldId}}` | The answer to a field |
| `{{steps.stepId}}` | A step’s whole result |
| `{{steps.stepId.key}}` | One key of a `json` step’s result |
| `{{lists.listId}}` | A stored list as a table, as it is when the step starts |
| `{{today}}` | Today’s date |
| `{{brand.name}}`, `{{brand.about}}`, `{{brand.colors}}` | The space’s brand |
| `{{brand.brandName}}`, `{{brand.tagline}}` | The brand’s name as it is written (the title where it has none) and its tagline |
| `{{brand.voice}}`, `{{brand.links}}` | How the brand speaks (tone, audience, positioning, …) and where it is found on the web |
| `{{facts.key}}`, `{{facts}}` | One fact of the space, such as its address or VAT ID, or all of them |

Every AI step already knows the brand and the facts. Name one only where the text must carry it.

## Fields with more than one value

| Template | What it gives |
|---|---|
| `{{itemsField}}` | The line items as a table with net, VAT and total |
| `{{itemsField.net}}`, `.vat`, `.gross` | One of the totals |
| `{{fileField}}` | The names of the uploads |
| `{{field.speech}}` | A `file` field with `listen`: what is said, piece by piece with times |
| `{{audioField}}`, `{{audioField.seconds}}` | What the person said, and how long |
| `{{locationField}}` | The address with its position, for example “Herrengasse 16, Graz (47.07071, 15.43950, ±12 m)” |
| `.lat`, `.lng`, `.accuracy`, `.label`, `.map` | One part of a location, `.map` a map link |
| `{{signatureField}}` | The picture as `asset://ID`, for `<img src="asset://ID">` in a document |

Documents take `{{itemsField}}` as it is. The runner computes the totals, never a model.

## Inside a step with `each`

| Template | What it gives |
|---|---|
| `{{item.column}}` | One column of the current entry |
| `{{index}}` | The number of the entry |
| `{{count}}` | How many entries there are |

## References outside templates

Other keys name the same things without braces: `prefill`, `optionsFrom`, `each`, a widget’s or
surface’s `data` and a condition’s `field`. They take `fieldId`, `steps.<id>`, `steps.<id>.<key>`
and `lists.<id>`, as each key’s page says.
