import type { PrismaUserDelegate, SubscriptionStatusOptions } from '../../shared/types';
import { type MiddlewareConfigFn, HttpError } from 'wasp/server';
import { type StripeWebhook } from 'wasp/server/api';
import express from 'express';
import { Stripe } from 'stripe';
import { stripe } from '../stripe/stripeClient';
import { paymentPlans } from '../stripe/paymentPlans';
import { SubscriptionPlanId } from '../../shared/constants';
import { updateUserStripePaymentDetails } from './stripePaymentDetails';
import { emailSender } from 'wasp/server/email';
import { z } from 'zod';

export const stripeWebhook: StripeWebhook = async (request, response, context) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || secret.length <= 9) {
    throw new HttpError(500, 'Stripe Webhook Secret Not Set');
  }
  const sig = request.headers['stripe-signature'];
  if (!sig) {
    throw new HttpError(400, 'Stripe Webhook Signature Not Provided');
  }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(request.body, sig, secret);
  } catch (err) {
    throw new HttpError(400, 'Error Constructing Stripe Webhook Event');
  }
  const prismaUserDelegate = context.entities.User;
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object as Stripe.Checkout.Session;
      await handleCheckoutSessionCompleted(session, prismaUserDelegate);
      break;
    case 'invoice.paid':
      const invoice = event.data.object as Stripe.Invoice;
      await handleInvoicePaid(invoice, prismaUserDelegate);
      break;
    case 'customer.subscription.updated':
      const updatedSubscription = event.data.object as Stripe.Subscription;
      await handleCustomerSubscriptionUpdated(updatedSubscription, prismaUserDelegate);
      break;
    case 'customer.subscription.deleted':
      const deletedSubscription = event.data.object as Stripe.Subscription;
      await handleCustomerSubscriptionDeleted(deletedSubscription, prismaUserDelegate);
      break;
    default:
      // If you'd like to handle more events, you can add more cases above.
      // When deploying your app, you configure your webhook in the Stripe dashboard to only send the events that you're
      // handling above and that are necessary for the functioning of your app. See: https://docs.opensaas.sh/guides/deploying/#setting-up-your-stripe-webhook 
      // In development, it is likely that you will receive other events that you are not handling, and that's fine. These can be ignored without any issues.
      console.error('Unhandled event type: ', event.type);
  }
  response.json({ received: true }); // Stripe expects a 200 response to acknowledge receipt of the webhook
};

// This allows us to override Wasp's defaults and parse the raw body of the request from Stripe to verify the signature
export const stripeMiddlewareFn: MiddlewareConfigFn = (middlewareConfig) => {
  middlewareConfig.delete('express.json');
  middlewareConfig.set('express.raw', express.raw({ type: 'application/json' }));
  return middlewareConfig;
};


export async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  prismaUserDelegate: PrismaUserDelegate
) {
  const userStripeId = validateUserStripeIdOrThrow(session.customer);
  const { line_items } = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ['line_items'],
  });
  console.log('line_items: ', line_items);
  const lineItemPriceId = validateAndUseLineItemData(line_items);

  let subscriptionPlan: SubscriptionPlanId | undefined;
  let numOfCreditsPurchased: number | undefined;
  for (const paymentPlan of Object.values(paymentPlans)) {
    if (paymentPlan.stripePriceID === lineItemPriceId) {
      subscriptionPlan = paymentPlan.subscriptionPlan;
      numOfCreditsPurchased = paymentPlan.credits;
      break;
    }
  }

  return await updateUserStripePaymentDetails(
    { userStripeId, subscriptionPlan, numOfCreditsPurchased, datePaid: new Date() },
    prismaUserDelegate
  );
}

export async function handleInvoicePaid(invoice: Stripe.Invoice, prismaUserDelegate: PrismaUserDelegate) {
  const userStripeId = validateUserStripeIdOrThrow(invoice.customer);
  const datePaid = new Date(invoice.period_start * 1000);
  return await updateUserStripePaymentDetails({ userStripeId, datePaid }, prismaUserDelegate);
}

export async function handleCustomerSubscriptionUpdated(
  subscription: Stripe.Subscription,
  prismaUserDelegate: PrismaUserDelegate
) {
  const userStripeId = validateUserStripeIdOrThrow(subscription.customer);
  let subscriptionStatus: SubscriptionStatusOptions | undefined;

  switch (subscription.status as Stripe.Subscription.Status) {
    case 'active':
      subscriptionStatus = 'active';
      break;
    case 'past_due':
      subscriptionStatus = 'past_due';
      break;
  }
  if (subscription.cancel_at_period_end) {
    subscriptionStatus = 'cancel_at_period_end';
  }
  if (!subscriptionStatus) throw new HttpError(400, 'Subscription status not handled');

  const user = await updateUserStripePaymentDetails({ userStripeId, subscriptionStatus }, prismaUserDelegate);

  if (subscription.cancel_at_period_end) {
    if (user.email) {
      await emailSender.send({
        to: user.email,
        subject: 'We hate to see you go :(',
        text: 'We hate to see you go. Here is a sweet offer...',
        html: 'We hate to see you go. Here is a sweet offer...',
      });
    }
  }

  return user;
}

export async function handleCustomerSubscriptionDeleted(
  subscription: Stripe.Subscription,
  prismaUserDelegate: PrismaUserDelegate
) {
  const userStripeId = validateUserStripeIdOrThrow(subscription.customer);
  return await updateUserStripePaymentDetails({ userStripeId, subscriptionStatus: 'deleted' }, prismaUserDelegate);
}

const LineItemsPriceSchema = z.object({
  data: z.array(
    z.object({
      price: z.object({
        id: z.string(),
      }),
    })
  ),
});

function validateAndUseLineItemData(line_items: Stripe.ApiList<Stripe.LineItem> | undefined) {
  const result = LineItemsPriceSchema.safeParse(line_items);

  if (!result.success) {
    throw new HttpError(400, 'No price id in line item');
  }
  if (result.data.data.length > 1) {
    throw new HttpError(400, 'More than one line item in session');
  }
  return result.data.data[0].price.id;
}

function validateUserStripeIdOrThrow(userStripeId: Stripe.Checkout.Session['customer']) {
  if (!userStripeId) throw new HttpError(400, 'No customer id');
  if (typeof userStripeId !== 'string') throw new HttpError(400, 'Customer id is not a string');
  return userStripeId;
}