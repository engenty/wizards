import type { SurfaceComponent } from "@engenty-wizards/shared/surface";

/**
 * Kühlschrank-Koch: what one agent step returns from photos of a fridge once steps can return
 * nested data, and the view its result shows: the shape its `output.schema` (data-shape.ts)
 * delivers.
 */
export const fridgePlan = {
  summary:
    "Viel Gemüse, ein Rest Feta und sechs Eier. Ich fange mit dem Spinat an, der muss bald weg.",
  inventory: [
    { name: "Eier", amount: "6 Stück", category: "Milchprodukte & Eier", use_soon: false },
    { name: "Feta", amount: "ca. 150 g", category: "Milchprodukte & Eier", use_soon: false },
    { name: "Spinat", amount: "1 Beutel", category: "Obst & Gemüse", use_soon: true },
    { name: "Paprika", amount: "2 Stück", category: "Obst & Gemüse", use_soon: false },
    { name: "Joghurt", amount: "1 Becher", category: "Milchprodukte & Eier", use_soon: true },
    { name: "Zucchini", amount: "1 Stück", category: "Obst & Gemüse", use_soon: false },
    { name: "Karotten", amount: "4 Stück", category: "Obst & Gemüse", use_soon: false },
    { name: "Hähnchenschenkel", amount: "4 Stück", category: "Fleisch & Fisch", use_soon: true },
    { name: "Frischkäse", amount: "1 Packung", category: "Milchprodukte & Eier", use_soon: false },
  ],
  days: [
    {
      label: "Tag 1 · Do 15. Okt",
      theme: "Levantinischer Abend",
      meals: [
        { slot: "Mittag", recipe_id: "r3" },
        { slot: "Abend", recipe_id: "r1" },
      ],
    },
    {
      label: "Tag 2 · Fr 16. Okt",
      theme: "Alles vom Blech",
      meals: [
        { slot: "Mittag", recipe_id: "r5" },
        { slot: "Abend", recipe_id: "r2" },
      ],
    },
    {
      label: "Tag 3 · Sa 17. Okt",
      theme: "Resteküche deluxe",
      meals: [
        { slot: "Mittag", recipe_id: "r5" },
        { slot: "Abend", recipe_id: "r4" },
      ],
    },
  ],
  recipes: [
    {
      id: "r1",
      title: "Shakshuka mit Feta",
      description: "Eier in würziger Paprika-Tomaten-Sauce, mit Feta und Kräutern.",
      cuisine: "Levantinisch",
      time_minutes: 25,
      difficulty: "leicht",
      servings: 2,
      ingredients: [
        { name: "Eier", amount: "4 Stück", in_fridge: true },
        { name: "Paprika, rot", amount: "1 Stück", in_fridge: true },
        { name: "Tomaten, stückig", amount: "1 Dose", in_fridge: false },
        { name: "Feta", amount: "100 g", in_fridge: true },
        { name: "Zwiebel", amount: "1 Stück", in_fridge: true },
      ],
      steps: [
        { text: "Zwiebel und Paprika in Streifen schneiden.", minutes: 5 },
        {
          text: "In Olivenöl bei mittlerer Hitze weich braten, Gewürze kurz mitrösten.",
          minutes: 7,
        },
        { text: "Tomaten dazugeben, salzen und 8 Minuten einköcheln lassen.", minutes: 8 },
        {
          text: "Vier Mulden formen, Eier hineinschlagen, Deckel drauf, stocken lassen.",
          minutes: 5,
        },
        { text: "Feta darüberbröseln und mit Brot servieren.", minutes: 0 },
      ],
      tip: "Nimm die Pfanne vom Herd, sobald das Eiweiß gerade weiß ist – dann bleibt das Eigelb flüssig.",
    },
    {
      id: "r2",
      title: "Zitronen-Hähnchen mit Ofengemüse",
      description: "Hähnchenschenkel mit Zucchini, Karotten und Kartoffeln vom Blech.",
      cuisine: "Mediterran",
      time_minutes: 45,
      difficulty: "mittel",
      servings: 2,
      ingredients: [
        { name: "Hähnchenschenkel", amount: "4 Stück", in_fridge: true },
        { name: "Zucchini", amount: "1 Stück", in_fridge: true },
        { name: "Karotten", amount: "3 Stück", in_fridge: true },
        { name: "Kartoffeln", amount: "500 g", in_fridge: false },
        { name: "Zitrone", amount: "1 Stück", in_fridge: false },
      ],
      steps: [
        { text: "Ofen auf 220 °C Umluft vorheizen.", minutes: 0 },
        { text: "Kartoffeln vierteln, Gemüse in grobe Stücke schneiden.", minutes: 8 },
        { text: "Alles mit Öl, Salz und Zitronenschale mischen, aufs Blech geben.", minutes: 4 },
        { text: "Hähnchen mit der Haut nach oben auflegen und backen.", minutes: 35 },
      ],
      tip: "Die Haut wird knuspriger, wenn du sie vorher trocken tupfst.",
    },
    {
      id: "r3",
      title: "Cremige Spinat-Pasta",
      description: "Schnelle Pasta mit Spinat, Frischkäse und Parmesan.",
      cuisine: "Italienisch",
      time_minutes: 20,
      difficulty: "leicht",
      servings: 2,
      ingredients: [
        { name: "Spaghetti", amount: "400 g", in_fridge: false },
        { name: "Blattspinat", amount: "200 g", in_fridge: true },
        { name: "Frischkäse", amount: "150 g", in_fridge: true },
        { name: "Parmesan", amount: "50 g", in_fridge: false },
      ],
      steps: [
        {
          text: "Pasta in Salzwasser al dente kochen, eine Tasse Kochwasser aufheben.",
          minutes: 10,
        },
        { text: "Spinat in Öl zusammenfallen lassen.", minutes: 3 },
        { text: "Frischkäse und Kochwasser unterrühren, Pasta untermischen.", minutes: 2 },
      ],
      tip: "Ein Spritzer Zitrone macht die Sauce frischer.",
    },
    {
      id: "r4",
      title: "Feta-Paprika-Omelett",
      description: "Was vom Feta übrig ist, in einem schnellen Omelett.",
      cuisine: "Mediterran",
      time_minutes: 15,
      difficulty: "leicht",
      servings: 2,
      ingredients: [
        { name: "Eier", amount: "2 Stück", in_fridge: true },
        { name: "Feta", amount: "50 g", in_fridge: true },
        { name: "Paprika", amount: "1 Stück", in_fridge: true },
      ],
      steps: [
        { text: "Paprika würfeln und kurz anbraten.", minutes: 4 },
        { text: "Verquirlte Eier darübergießen, Feta darüberbröseln, stocken lassen.", minutes: 6 },
      ],
      tip: "Bei kleiner Hitze bleibt das Omelett saftig.",
    },
    {
      id: "r5",
      title: "Gemüse-Curry mit Kokosmilch",
      description: "Mildes rotes Curry mit den Gemüseresten der Woche.",
      cuisine: "Thai",
      time_minutes: 30,
      difficulty: "leicht",
      servings: 4,
      ingredients: [
        { name: "Kokosmilch", amount: "1 Dose", in_fridge: false },
        { name: "Zucchini", amount: "½ Stück", in_fridge: true },
        { name: "Karotten", amount: "2 Stück", in_fridge: true },
        { name: "Reis", amount: "250 g", in_fridge: false },
      ],
      steps: [
        { text: "Reis aufsetzen.", minutes: 15 },
        { text: "Gemüse anbraten, Currypaste kurz mitrösten.", minutes: 6 },
        { text: "Mit Kokosmilch ablöschen und köcheln lassen.", minutes: 10 },
      ],
      tip: "Für Tag 3 die Hälfte gleich in eine Box füllen.",
    },
  ],
  shopping_list: [
    {
      name: "Zitrone",
      amount: "1 Stück",
      category: "Obst & Gemüse",
      for_recipes: ["Zitronen-Hähnchen"],
    },
    {
      name: "Kartoffeln",
      amount: "500 g",
      category: "Obst & Gemüse",
      for_recipes: ["Zitronen-Hähnchen"],
    },
    {
      name: "Tomaten, stückig",
      amount: "1 Dose",
      category: "Trockenwaren & Konserven",
      for_recipes: ["Shakshuka"],
    },
    {
      name: "Kokosmilch",
      amount: "1 Dose",
      category: "Trockenwaren & Konserven",
      for_recipes: ["Gemüse-Curry"],
    },
    {
      name: "Spaghetti",
      amount: "400 g",
      category: "Trockenwaren & Konserven",
      for_recipes: ["Spinat-Pasta"],
    },
    {
      name: "Reis",
      amount: "250 g",
      category: "Trockenwaren & Konserven",
      for_recipes: ["Gemüse-Curry"],
    },
    {
      name: "Parmesan",
      amount: "50 g",
      category: "Milchprodukte & Eier",
      for_recipes: ["Spinat-Pasta"],
    },
  ],
};

const MEAL_META = [{ path: "time_minutes", format: "{} Min" }, { path: "difficulty" }];

/** The view of the plan, written once: what the architect would write for this result. */
export const fridgeView: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["lead", "found", "tabs"] },
  { id: "lead", component: "Text", variant: "lead", text: { path: "/summary" } },
  {
    id: "found",
    component: "Chips",
    title: "Im Kühlschrank erkannt",
    items: { path: "/inventory" },
    labelKey: "name",
    flagKey: "use_soon",
    flag: "bald",
  },
  {
    id: "tabs",
    component: "Tabs",
    tabs: [
      { label: "Menüplan", child: "plan" },
      { label: "Einkauf", count: { path: "/shopping_list" }, child: "shop" },
      { label: "Rezepte", count: { path: "/recipes" }, child: "recipes" },
    ],
  },
  {
    id: "plan",
    component: "Grid",
    columns: 3,
    min: 14,
    children: { path: "/days", componentId: "day" },
  },
  {
    id: "day",
    component: "Card",
    eyebrow: { path: "label" },
    title: { path: "theme" },
    children: ["meals"],
  },
  { id: "meals", component: "Column", children: { path: "meals", componentId: "meal" } },
  {
    id: "meal",
    component: "Link",
    eyebrow: { path: "slot" },
    items: { path: "/recipes" },
    value: { path: "recipe_id" },
    view: "recipe",
    title: { path: "title" },
    meta: MEAL_META,
  },
  {
    id: "shop",
    component: "Checklist",
    items: { path: "/shopping_list" },
    labelKey: "name",
    detailKey: "amount",
    noteKey: "for_recipes",
    noteFormat: "für {}",
    groupKey: "category",
    groupOrder: [
      "Obst & Gemüse",
      "Fleisch & Fisch",
      "Milchprodukte & Eier",
      "Trockenwaren & Konserven",
    ],
  },
  {
    id: "recipes",
    component: "Grid",
    columns: 2,
    min: 14,
    children: { path: "/recipes", componentId: "tile" },
  },
  {
    id: "tile",
    component: "Link",
    look: "card",
    items: { path: "/recipes" },
    value: { path: "id" },
    view: "recipe",
    title: { path: "title" },
    subtitle: { path: "description" },
    meta: MEAL_META,
  },
  { id: "recipe", component: "Column", children: ["head", "ingFold", "stepFold", "tip"] },
  {
    id: "head",
    component: "Card",
    title: { path: "title" },
    subtitle: { path: "description" },
    meta: [...MEAL_META, { path: "servings", format: "{} Portionen" }, { path: "cuisine" }],
  },
  { id: "ingFold", component: "Fold", title: "Zutaten", open: true, children: ["ings"] },
  { id: "ings", component: "List", children: { path: "ingredients", componentId: "ing" } },
  {
    id: "ing",
    component: "Row",
    title: { path: "name" },
    meta: { path: "amount" },
    badge: { path: "in_fridge", map: { true: "im Kühlschrank", false: "einkaufen" } },
    badgeTone: { path: "in_fridge", map: { true: "success", false: "accent" } },
  },
  { id: "stepFold", component: "Fold", title: "Zubereitung", open: true, children: ["steps"] },
  { id: "steps", component: "Steps", items: { path: "steps" } },
  { id: "tip", component: "Callout", title: "Tipp vom Koch:", text: { path: "tip" } },
];
