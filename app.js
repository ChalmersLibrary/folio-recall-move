#!/usr/bin/env node
const fetch = require ('node-fetch')
const {performance} = require('perf_hooks');
const nodemailer = require('nodemailer');
const MailMessage = require('nodemailer/lib/mailer/mail-message');
require('dotenv').config()

const start = performance.now()

const username = process.env.FOLIO_USER
const password = process.env.FOLIO_PASSWORD
const okapi = process.env.OKAPI_URL
const tenant = process.env.OKAPI_TENANT
const permLoanId = process.env.PERMANENTLOANTYPEID
const skipBarcode = process.env.SKIPBARCODE
const liveMove = process.env.LIVEMOVE
const mailTo = process.env.MAILTO
const recallUrl = process.env.RECALLURL
const smtpHost = process.env.SMTP_HOST
const smtpUser = process.env.SMTP_USER
const smtpPassword = process.env.SMTP_PASSWORD
const locale = process.env.LOCALE

let token = ""

let recalls_to_move = []
let has_available_items = 0
let has_no_available_items = 0
let num_records = 0
let moved = []
let skipped = 0

if(!username || !password || !okapi || !tenant || !permLoanId || !skipBarcode || !liveMove || !mailTo || !recallUrl || !smtpUser || !smtpPassword) {
  console.log('Needed environtment varialbes missing.')
  process.exit()
}

async function login() {
  let response = await fetch(`${okapi}/authn/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-okapi-tenant': tenant
    },
    body: `{
      "username":"${username}",
      "password":"${password}"
    }`
  })
  token = response.headers.get('x-okapi-token')
  return response.ok
}

async function get_recalls() {
  let response = await fetch(`${okapi}/circulation/requests?query=(requestType=="Recall" and status="Open - Not yet filled")&limit=500`, {
    method: 'GET',
    headers: {
      'Conent-Type': 'application/json',
      'x-okapi-tenant': tenant,
      'x-okapi-token': token
    }
  })
  let json = await response.json()
  return json.requests
}

async function get_available(linked_instance) {
  let response = await fetch(`${okapi}/inventory/items?query=(instance.id==${linked_instance} AND status.name=="Available" AND permanentLoanTypeId=="${permLoanId}")&limit=100`, {
    method: 'GET',
    headers: {
      'Conent-Type': 'application/json',
      'x-okapi-tenant': tenant,
      'x-okapi-token': token
    }
  })
  let json = await response.json()
  return json.items
}

async function move_recall(id, itemId) {
  let response = await fetch(`${okapi}/circulation/requests/${id}/move`, {
    method: 'POST',
    headers: {
      'Conent-Type': 'application/json',
      'x-okapi-tenant': tenant,
      'x-okapi-token': token
    },
    body: `{
      "destinationItemId": "${itemId}",
      "requestType": "Page"
    }`
  })
  let json = await response.json()
  return json.requests
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  let ok = await login()
  if(ok) {
    let incomingRequests = await get_recalls()
    let requests = incomingRequests.sort((a,b) => {
      return new Date(a.requestDate) - new Date(b.requestDate)
    })
    console.log(`To process ${requests.length} Moving: ${liveMove}`);
    for(var i in requests) {
      num_records +=1
      let request_date = requests[i].requestDate
      let linked_instance = requests[i].item.instanceId
      let title = requests[i].item.title
      let requester = requests[i].requester.barcode
      let requestDate = requests[i].requestDate
      let pickupLocation = requests[i].pickupServicePoint.name.split(" ")[0]
      if(requester == skipBarcode) {
        skipped += 1
        continue
      }
      let items = await get_available(linked_instance)
      
      if(items.length > 0) {
        let recall_id = requests[i].id
        let recall_url = `${recallUrl}${recall_id}`

        let recall_info = `${linked_instance} ${recall_url} (${request_date} ${requester})  ${title}`
        recalls_to_move.push(recall_info)
        has_available_items += 1
        let itemIndex = items.findIndex(item => item.effectiveLocation.name.toLowerCase().includes(pickupLocation.toLowerCase()))
        let idx = itemIndex > 0 ? itemIndex : 0
        let moving = {title: title, url:recall_url, id: recall_id, barcode: items[idx].barcode, requestDate: new Date(requestDate).toLocaleString(locale) }
        moved.push(moving)

        if(liveMove == "TRUE") {
          await move_recall(recall_id, items[idx].id)
        }
      } else {
        has_no_available_items += 1
      }

      await sleep(10)
    }
  }

  let transporter = nodemailer.createTransport({
    host: smtpHost,
    port: 587,
    secure: false,
    auth: {
      user: smtpUser,
      pass: smtpPassword
    }
  })

  let processed = `Processed: ${num_records}\t Availabe/No: ${has_available_items}/${has_no_available_items}\tMoved: ${moved.length}\tSkiped: ${skipped}`
  let mailMessage = ""
  let htmlMailMessage = ""
  let logMessage = ""
  moved.forEach(recall => {
    mailMessage += `${recall.title} Move recall id ${recall.id} to barcode ${recall.barcode}, requested: ${recall.requestDate}\n`
    htmlMailMessage +=`<strong>${recall.title}</strong> Move recall id <a href="${recall.url}">${recall.id}</a> to barcode ${recall.barcode}, requested: ${recall.requestDate}<br>`
    logMessage +=`${recall.title}: ${recall.url} barcode:${recall.barcode} requested: ${recall.requestDate}\n`
  });

  console.log(processed);
  if(moved.length>0){
    let info = await transporter.sendMail({
      from: '"Library No Reply" <noreply.lib@chalmers.se>',
      to: mailTo,
      subject: "Requests moved to available items",
      text: mailMessage,
      html: htmlMailMessage
    })
    console.log(`Message sent: ${info.messageId}`)
  }

  moved.length > 0 ? console.log(`Moved:\n${logMessage}`):console.log('Nothing moved.');
}

main().catch(err => console.log(err))
