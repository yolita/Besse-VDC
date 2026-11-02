# Besse Water

A responsive, browser-based starter application for the Besse Village Development Committee's community water service.

## Supabase setup

The app uses a hosted Supabase project for shared storage; it does not require a local database server. Before using it:

1. Create a Supabase project and open its SQL Editor.
2. Run the contents of `supabase-schema.sql` to create or upgrade the tables, private `payment-receipts` Storage bucket, and authenticated-workspace-member access policies. Existing application records are migrated to a household record each.
3. In Supabase Authentication, create or invite accounts for trusted VDC staff. Disable public sign-up in the Supabase project's authentication settings.
4. Copy the HTTPS **Project URL** (not the PostgreSQL connection string) and **anon/public key** from the project's API settings into `supabase-config.js`.
5. Serve the app from a web host over HTTPS. Opening the HTML directly as a `file://` URL is not supported for cloud sign-in.
6. Configure database backups in Supabase and test restoring them.

After creating/inviting each staff account, add that user to `public.workspace_members` using the Supabase SQL Editor. For example, after replacing the email, run:

```sql
insert into public.workspace_members (user_id)
select id from auth.users where email = lower('staff@example.org')
on conflict (user_id) do nothing;
```

The anon/public key is intended for browser use and is not a secret. Never put a `service_role` or other privileged key in this app. Row-level security restricts the workspace to users explicitly listed in `workspace_members`; all listed users can access the shared workspace. Configure allowed redirect URLs and authentication settings in Supabase for the deployed app.

The app does not automatically import records from previous browser `localStorage`; export or migrate those records before switching if they need to be retained. Until a real project URL and anon key are configured and the SQL is run, the app cannot connect or store records.

## Open the app

Host the files in a modern browser over HTTPS. No local database server or application build step is required.

## Main workflows

1. Under **Settings**, set the approved water tariff and configure the VDC chairperson's name. The configured name is prefilled when approving applications; the name recorded on each approval can still be changed if needed.
2. Submit a water connection request from **New application**.
3. Review the request under **Applications**. Use **Edit application** on the review page to update the application, household, meter, fee, and documentation details. Household contact and property edits apply to all meters linked to that household. The VDC chairperson's name is recorded when approving; applicant and VDC signatures remain offline.
4. Record meter readings under **Metering & billing**. Each reading generates an invoice; usage is calculated from the previous reading and the tariff in effect when the reading is saved. To enter readings in bulk, download the Excel template, fill in the current meter reading for each account, upload the workbook, review validation, and import. The upload date is assigned automatically as the reading date. A successful import saves all readings and generates one invoice per reading; if any row fails validation, none are imported.
5. Record payments and review payment history under **Payments**. Choose the invoice to link each payment to; partial payments and overpayments are allowed.
6. View approved connections and account balances under **Customers**. Select a customer's name to see all invoices and payments recorded for that meter account; each list is paginated in groups of 10.

Billing history shows meter readings, generated invoice numbers, and charges separately from payment history. Payment history shows the invoice linked to each payment. A customer's account detail shows all invoices, invoice balances, and payments for that meter, including historical payments with no invoice link. Payments may be partial or exceed the invoice balance; invoice balances are calculated from payments linked to that invoice. Billing History and Payment History can each be filtered independently by an inclusive date range and household/meter; the filters can be combined and adjusted independently. Payment History also has an independent invoice filter. Each panel has one **Clear all filters** button. Pagination applies to the filtered results. Only one meter reading is allowed per meter per calendar month; the app validates this and the database enforces it with a unique index. Payment entry accepts an optional JPG, PNG, or WebP receipt image up to 5 MB; images are kept in a private Supabase Storage bucket and are not displayed in Payment history. Existing payments remain unlinked to avoid guessing which invoice they paid; new payments must select an invoice.


The registration includes the applicant, property, connection, documentation checklist, connection-fee, alternate-contact, and supply-location details from the VDC form. Identity document files are not uploaded or stored.

Household identity and property details are stored in dedicated columns in `public.households` (including name, date of birth, phone, ID number, address, plot, property type, and alternate contact). A household may have multiple applications; each approved application represents one meter/account, and meter readings and their invoices are linked to that specific application. When submitting a new application, staff can register a household or select an existing one to add another meter. The schema migration backfills these columns from existing household JSON records, creates invoices for existing meter readings, and adds the workspace chairperson setting. Run the updated `supabase-schema.sql` in the Supabase SQL Editor to enable invoice storage, payment links, and the chairperson setting.

## Important data and deployment limitations

- Records are saved in the configured Supabase project and are shared among authenticated users in that project. Backups and recovery depend on the project's Supabase settings and plan.
- Every user listed in `workspace_members` can access this single shared workspace. Remove their membership and Supabase account when access is no longer needed.
- Payments are recorded manually; the app does not connect to a bank or mobile-money provider.
- Configure the water rate approved by the VDC. No default rate is assumed.
