import { type ObjectSchema, type ObjectShape, shapeOfSchema } from "@engenty/wizards-shared/shape";

/**
 * Kühlschrank-Koch's `output.schema`: what its agent step returns from photos of a fridge, in the
 * subset of JSON Schema the format takes. The view lab draws the admin's view and edit from it.
 */
const CATEGORIES = [
  "Obst & Gemüse",
  "Fleisch & Fisch",
  "Milchprodukte & Eier",
  "Trockenwaren & Konserven",
  "Gewürze & Saucen",
  "Sonstiges",
];

/** Kühlschrank-Koch's plan, as the architect would write its schema. */
export const fridgeSchema: ObjectSchema = {
  type: "object",
  title: "Menüplan",
  properties: {
    summary: {
      type: "string",
      title: "Zusammenfassung",
      "x-long": true,
    },
    inventory: {
      type: "array",
      title: "Im Kühlschrank erkannt",
      items: {
        type: "object",
        title: "Lebensmittel",
        properties: {
          name: {
            type: "string",
            title: "Name",
          },
          amount: {
            type: "string",
            title: "Menge",
          },
          category: {
            type: "string",
            title: "Abteilung",
            enum: CATEGORIES,
          },
          use_soon: {
            type: "boolean",
            title: "Bald verbrauchen",
          },
        },
      },
    },
    days: {
      type: "array",
      title: "Tage",
      items: {
        type: "object",
        title: "Tag",
        properties: {
          label: {
            type: "string",
            title: "Tag",
          },
          theme: {
            type: "string",
            title: "Motto",
          },
          meals: {
            type: "array",
            title: "Mahlzeiten",
            items: {
              type: "object",
              title: "Mahlzeit",
              properties: {
                slot: {
                  type: "string",
                  title: "Mahlzeit",
                  enum: ["Frühstück", "Mittag", "Abend"],
                },
                recipe_id: {
                  type: "string",
                  title: "Rezept",
                  "x-ref": "recipes",
                },
              },
            },
          },
        },
      },
    },
    recipes: {
      type: "array",
      title: "Rezepte",
      items: {
        type: "object",
        title: "Rezept",
        properties: {
          id: {
            type: "string",
            title: "Kennung",
            description: "Short and unique: r1, r2, …",
          },
          title: {
            type: "string",
            title: "Titel",
          },
          description: {
            type: "string",
            title: "Beschreibung",
            "x-long": true,
          },
          cuisine: {
            type: "string",
            title: "Küche",
          },
          time_minutes: {
            type: "number",
            title: "Zeit",
            "x-unit": "Min",
          },
          difficulty: {
            type: "string",
            title: "Schwierigkeit",
            enum: ["leicht", "mittel", "anspruchsvoll"],
          },
          servings: {
            type: "number",
            title: "Portionen",
          },
          ingredients: {
            type: "array",
            title: "Zutaten",
            items: {
              type: "object",
              title: "Zutat",
              properties: {
                name: {
                  type: "string",
                  title: "Zutat",
                },
                amount: {
                  type: "string",
                  title: "Menge",
                },
                in_fridge: {
                  type: "boolean",
                  title: "Im Kühlschrank",
                  "x-yes": "da",
                  "x-no": "einkaufen",
                },
              },
            },
          },
          steps: {
            type: "array",
            title: "Zubereitung",
            items: {
              type: "object",
              title: "Schritt",
              properties: {
                text: {
                  type: "string",
                  title: "Schritt",
                  "x-long": true,
                },
                minutes: {
                  type: "number",
                  title: "Dauer",
                  "x-unit": "Min",
                },
              },
            },
          },
          tip: {
            type: "string",
            title: "Tipp",
            "x-long": true,
          },
        },
      },
    },
    shopping_list: {
      type: "array",
      title: "Einkaufsliste",
      items: {
        type: "object",
        title: "Artikel",
        properties: {
          name: {
            type: "string",
            title: "Artikel",
          },
          amount: {
            type: "string",
            title: "Menge",
          },
          category: {
            type: "string",
            title: "Abteilung",
            enum: CATEGORIES,
          },
          for_recipes: {
            type: "array",
            title: "Für",
            items: {
              type: "string",
              title: "Rezept",
            },
          },
        },
      },
    },
  },
};

/** The schema read as a shape: what the view lab and the editors go by. */
export const fridgeShape: ObjectShape = shapeOfSchema(fridgeSchema);
