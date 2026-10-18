import { getProviderCapabilities } from "@/utils/email/provider-registry";

interface EmailTerminology {
  label: {
    singular: string;
    plural: string;
    singularCapitalized: string;
    pluralCapitalized: string;
    action: string;
  };
}

/**
 * Gmail organizes mail with labels. Providers without that capability use
 * folder/category wording instead.
 */
export function getEmailTerminology(provider: string): EmailTerminology {
  if (getProviderCapabilities(provider).labels) {
    return {
      label: {
        singular: "label",
        plural: "labels",
        singularCapitalized: "Label",
        pluralCapitalized: "Labels",
        action: "Label",
      },
    };
  }

  return {
    label: {
      singular: "category",
      plural: "categories",
      singularCapitalized: "Category",
      pluralCapitalized: "Categories",
      action: "Categorize",
    },
  };
}
