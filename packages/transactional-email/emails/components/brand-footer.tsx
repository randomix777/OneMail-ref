import { Hr, Img, Link, Section } from "@react-email/components";
import { BRAND_NAME } from "../../src/brand";

export function BrandFooter({ baseUrl }: { baseUrl?: string }) {
  const homepageUrl = baseUrl ?? "https://www.jyisolutions.com";
  const iconUrl = `${homepageUrl}/icon.png`;

  return (
    <>
      <Hr className="m-0 border-gray-200" />
      <Section className="bg-[#FDFDFD] px-8 py-4">
        <Link
          href={homepageUrl}
          className="text-[11px] text-gray-500 no-underline"
        >
          <table cellPadding="0" cellSpacing="0">
            <tr>
              <td className="pr-1 align-middle text-[11px] text-gray-500">
                Sent via
              </td>
              <td className="pr-1.5 align-middle">
                <Img
                  src={iconUrl}
                  width="14"
                  height="14"
                  alt=""
                  className="block"
                />
              </td>
              <td className="align-middle text-[11px] font-semibold text-gray-700">
                {BRAND_NAME}
              </td>
            </tr>
          </table>
        </Link>
      </Section>
    </>
  );
}
