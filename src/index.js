const {
  BaseKonnector,
  requestFactory,
  saveFiles,
  log,
  errors
} = require('cozy-konnector-libs')
const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true,
  jar: true
})

let currentToken = null

const VENDOR = 'ecoledirecte'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password, fields)
  log('info', 'Successfully logged in')

  const result = await request.post(
    'https://api.ecoledirecte.com/v3/Eleves/9090/cahierdetexte/2019-03-11.awp?verbe=get&',
    {
      form: {
        data: JSON.stringify({ token: currentToken })
      }
    }
  )

  currentToken = result.token

  const fichier = result.data.matieres.find(
    doc => doc.matiere === 'PHYSIQUE-CHIMIE'
  ).aFaire.documents[0]

  await saveFiles(
    [
      {
        fileurl: 'https://api.ecoledirecte.com/v3/telechargement.awp?verbe=get',
        filename: fichier.libelle,
        requestOptions: {
          method: 'POST',
          form: {
            token: currentToken,
            leTypeDeFichier: fichier.type,
            fichierId: fichier.id,
            anneeMessages: ''
          }
        }
      }
    ],
    fields,
    {
      requestInstance: request
    }
  )
}

async function authenticate(identifiant, motdepasse, fields) {
  let { token, data, code } = await request.post(
    'https://api.ecoledirecte.com/v3/login.awp',
    {
      form: {
        data: JSON.stringify({ identifiant, motdepasse })
      }
    }
  )

  if (code !== 200) {
    throw new Error(errors.LOGIN_FAILED)
  }

  currentToken = token
}
