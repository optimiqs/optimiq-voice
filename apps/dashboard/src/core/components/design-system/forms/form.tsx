/**
 * Form
 *
 * @description A form is a wrapper around a form element controller that provides
 * the necessary context for the form element to be accessible.
 *
 * @example
 * <Form {...form}>
 *  <form
      onSubmit={form.handleSubmit(onSubmit)}
      className="w-full space-y-4 max-w-md"
    >
 *    <FormField
 *      control={form.control}
 *      name="username"
 *      render={({ field }) => (
 *        <FormItem>
 *          <FormControl>
 *            <Input placeholder="Your username here..." {...field} />
 *          </FormControl>
 *          <FormMessage />
 *        </FormItem>
 *      )}
 *    />
 *  </form>
 * </Form>
 */
export { FormProvider as Form } from "react-hook-form";
